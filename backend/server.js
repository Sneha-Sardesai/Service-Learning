'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const crypto = require('crypto');
const {
  closePool,
  isDatabaseConfigured,
  query,
  transaction,
} = require('./database');
const {
  createRun,
  findOrCreateCompany,
  recoverInterruptedRuns,
} = require('./researchWorkflow');
const { normalizeCompanyName, normalizeWebsite, validateCompanyName } = require('./validation');
const { importFields, parseSpreadsheet, suggestMappings } = require('./spreadsheetImport');
const { reviewedMoneyFields } = require('./money');
const { enqueueResearch } = require('./researchQueue');
const { buildSearch } = require('./companySearch');

const app = express();
const port = Number(process.env.PORT || 5000);
const reviewStatuses = new Set(['pending_review', 'approved', 'rejected', 'unavailable']);
const researchStatuses = new Set(['not_started', 'queued', 'running', 'completed', 'partially_completed', 'failed']);

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const maxImportBytes = 15 * 1024 * 1024;
const importFindingFields = new Set([
  'csr_obligation_amount',
  'csr_expenditure_amount',
  'unspent_csr_amount',
  'turnover_amount',
  'revenue_amount',
  'sales_amount',
  'csr_focus_area',
  'csr_project',
  'csr_implementation_partner',
  'csr_committee',
  'csr_policy',
  'csr_observation',
]);

function importFilename(request) {
  const filename = path.basename(String(request.query.filename || ''));
  if (!filename || filename.length > 255) {
    const error = new Error('Provide the uploaded filename using the filename query parameter.');
    error.status = 400;
    throw error;
  }
  return filename;
}

function validateImportMappings(headers, mappings) {
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    const error = new Error('Column mappings must be an object keyed by spreadsheet header.');
    error.status = 400;
    throw error;
  }
  const targets = Object.values(mappings).filter(Boolean);
  if (targets.some((target) => !importFields.includes(target))
    || new Set(targets).size !== targets.length
    || Object.keys(mappings).some((header) => !headers.includes(header))) {
    const error = new Error('Column mappings contain an unknown header, field, or duplicate target.');
    error.status = 400;
    throw error;
  }
  if (!targets.includes('company_name')) {
    const error = new Error('Map a spreadsheet column to Company name before previewing the import.');
    error.status = 400;
    throw error;
  }
  if (Object.entries(mappings).some(([header, field]) => (
    ['csr_obligation_amount', 'csr_expenditure_amount', 'unspent_csr_amount'].includes(field)
      && /\b(turnover|revenue|sales)\b/i.test(header)
  ))) {
    const error = new Error('Turnover, revenue, and sales columns cannot be mapped to CSR expenditure fields.');
    error.status = 400;
    throw error;
  }
}

function mapImportRows(sheet, mappings) {
  return sheet.rows.map((original, index) => ({
    row_number: index + 2,
    original,
    mapped: Object.fromEntries(Object.entries(mappings)
      .filter(([, field]) => field)
      .map(([header, field]) => {
        let value = original[header] == null ? '' : String(original[header]).trim();
        if (field === 'contact_email' && value) {
          value = value.split(/[\r\n;,]+/).map((email) => email.trim()).filter(Boolean).join('; ');
        }
        if (field === 'publication_date' && /^\d{4}-\d{2}-\d{2}T/.test(value)) value = value.slice(0, 10);
        return [field, value];
      })),
  }));
}

function importRowErrors(row) {
  const errors = [];
  try {
    validateCompanyName(row.mapped.company_name);
  } catch (error) {
    errors.push(error.message);
  }
  if (row.mapped.company_alias) {
    try {
      validateCompanyName(row.mapped.company_alias);
    } catch (error) {
      errors.push(`company_alias: ${error.message}`);
    }
  }
  for (const [key, max] of Object.entries({
    company_alias: 200, cin: 21, industry: 160, city: 160, contact_email: 254, contact_phone: 40,
    contact_name: 200, contact_designation: 160, website_candidate: 2048, priority: 80, financial_year: 20,
    source_url: 2048, source_title: 500, source_document_type: 80,
  })) {
    const value = row.mapped[key];
    if (value && value.length > max) errors.push(`${key} must be ${max} characters or fewer.`);
  }
  if (row.mapped.contact_email
    && !row.mapped.contact_email.split('; ').every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    errors.push('contact_email must be a valid email address.');
  }
  if (row.mapped.source_url) {
    try {
      const url = new URL(row.mapped.source_url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        errors.push('source_url must be an http:// or https:// URL without credentials.');
      }
    } catch {
      errors.push('source_url must be a valid http:// or https:// URL.');
    }
  }
  if (row.mapped.publication_date) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(row.mapped.publication_date)
      ? new Date(`${row.mapped.publication_date}T00:00:00Z`)
      : null;
    if (!date || Number.isNaN(date.getTime())
      || date.toISOString().slice(0, 10) !== row.mapped.publication_date) {
      errors.push('publication_date must be a real date in YYYY-MM-DD format.');
    }
  }
  return errors;
}

async function loadImportFile(request) {
  const filename = importFilename(request);
  if (!Buffer.isBuffer(request.body) || !request.body.length) {
    const error = new Error('Upload a non-empty spreadsheet as application/octet-stream.');
    error.status = 400;
    throw error;
  }
  if (request.body.length > maxImportBytes) {
    const error = new Error('Spreadsheet exceeds the 15 MB upload limit.');
    error.status = 413;
    throw error;
  }
  const sheets = await parseSpreadsheet(request.body, filename);
  const sheetName = request.query.sheet ? String(request.query.sheet) : sheets[0]?.name;
  const sheet = sheets.find((item) => item.name === sheetName);
  if (!sheet) {
    const error = new Error('Select a worksheet that exists in the uploaded file.');
    error.status = 400;
    throw error;
  }
  if (!sheet.headers.length) {
    const error = new Error('The selected worksheet has no header row.');
    error.status = 400;
    throw error;
  }
  return { filename, sheets, sheet };
}

app.get('/', (_request, response) => {
  response.send('CSR research API is running. See /api/health for status.');
});

function parseId(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    const error = new Error('A valid numeric ID is required.');
    error.status = 400;
    throw error;
  }
  return Number(value);
}

function companyInput(body, existing = {}) {
  const name = body.company_name === undefined
    ? existing.company_name
    : validateCompanyName(body.company_name);
  const industry = body.industry === undefined ? existing.industry : body.industry;
  const cin = body.cin === undefined ? existing.cin : body.cin;
  const city = body.city === undefined ? existing.city : body.city;
  const contactEmail = body.contact_email === undefined ? existing.contact_email : body.contact_email;
  const contactPhone = body.contact_phone === undefined ? existing.contact_phone : body.contact_phone;
  const contactName = body.contact_name === undefined ? existing.contact_name : body.contact_name;
  const contactDesignation = body.contact_designation === undefined
    ? existing.contact_designation
    : body.contact_designation;
  const notes = body.notes === undefined ? existing.notes : body.notes;
  const websiteInput = body.official_website === undefined
    ? existing.official_website
    : body.official_website;
  const website = websiteInput ? normalizeWebsite(websiteInput) : (existing.official_website || null);
  if (website && (website !== existing.official_website
    || (existing.official_website && !existing.official_website_verified_at))
    && body.confirm_official_website !== true) {
    const error = new Error("Confirm that this is the company's official website before saving it.");
    error.status = 400;
    throw error;
  }
  if (industry !== null && industry !== undefined && (typeof industry !== 'string' || industry.length > 160)) {
    const error = new Error('Industry must be a text value of 160 characters or fewer.');
    error.status = 400;
    throw error;
  }
  if (notes !== null && notes !== undefined && (typeof notes !== 'string' || notes.length > 10000)) {
    const error = new Error('Notes must be a text value of 10,000 characters or fewer.');
    error.status = 400;
    throw error;
  }
  for (const [value, label, max] of [
    [cin, 'CIN', 21], [city, 'City', 160], [contactEmail, 'Contact email', 254],
    [contactPhone, 'Contact phone', 40], [contactName, 'Contact name', 200],
    [contactDesignation, 'Contact designation', 160],
  ]) {
    if (value !== null && value !== undefined && (typeof value !== 'string' || value.length > max)) {
      const error = new Error(`${label} must be text of ${max} characters or fewer.`);
      error.status = 400;
      throw error;
    }
  }
  return {
    name,
    normalizedName: normalizeCompanyName(name),
    industry: typeof industry === 'string' ? industry.trim() || null : null,
    cin: typeof cin === 'string' ? cin.trim() || null : null,
    city: typeof city === 'string' ? city.trim() || null : null,
    contactEmail: typeof contactEmail === 'string' ? contactEmail.trim() || null : null,
    contactPhone: typeof contactPhone === 'string' ? contactPhone.trim() || null : null,
    contactName: typeof contactName === 'string' ? contactName.trim() || null : null,
    contactDesignation: typeof contactDesignation === 'string' ? contactDesignation.trim() || null : null,
    notes: typeof notes === 'string' ? notes.trim() || null : null,
    website,
  };
}

async function getCompany(id) {
  const rows = await query('SELECT * FROM companies WHERE id = ?', [id]);
  if (!rows.length) {
    const error = new Error('Company not found.');
    error.status = 404;
    throw error;
  }
  return rows[0];
}

app.get('/api/health', async (_request, response) => {
  if (!isDatabaseConfigured()) {
    return response.status(503).json({
      status: 'degraded',
      database: 'not_configured',
      message: 'Copy .env.example to .env and configure MySQL before using the application.',
    });
  }
  try {
    await query('SELECT 1 FROM companies LIMIT 0');
    await query('SELECT warning_summary FROM research_runs LIMIT 0');
    await query('SELECT original_value FROM findings LIMIT 0');
    await query('SELECT 1 FROM research_run_documents LIMIT 0');
    await query('SELECT 1 FROM research_run_findings LIMIT 0');
    await query('SELECT 1 FROM import_batches LIMIT 0');
    await query('SELECT provenance, numeric_value FROM findings LIMIT 0');
    await query('SELECT cin, website_candidate, official_website_verified_at FROM companies LIMIT 0');
    await query('SELECT contact_name, contact_designation FROM companies LIMIT 0');
    await query('SELECT document_type, publication_date, link_text FROM documents LIMIT 0');
    await query('SELECT 1 FROM finding_review_history LIMIT 0');
    await query('SELECT 1 FROM company_aliases LIMIT 0');
    response.json({ status: 'ok', database: 'available' });
  } catch (error) {
    console.error(`Database health check failed: ${error.message}`);
    if (['ER_NO_SUCH_TABLE', 'ER_BAD_DB_ERROR', 'ER_BAD_FIELD_ERROR'].includes(error.code)) {
      return response.status(503).json({
        status: 'degraded',
        database: 'schema_missing',
        message: 'The database schema is incomplete. For a new database run database/schema.sql; for an existing database apply the database/migrations files in numeric order once.',
      });
    }
    response.status(503).json({
      status: 'degraded',
      database: 'unavailable',
      message: 'MySQL is unavailable. Check the local database service and .env settings.',
    });
  }
});

app.get('/api/dashboard', async (_request, response) => {
  const rows = await query(
    `SELECT
       (SELECT COUNT(*) FROM companies) AS total_companies,
       (SELECT COUNT(*) FROM companies WHERE research_status IN ('completed', 'partially_completed')) AS researched_companies,
       (SELECT COUNT(*) FROM companies WHERE research_status IN ('not_started', 'queued', 'running', 'failed')) AS pending_companies,
       (SELECT COUNT(*) FROM documents) AS documents_discovered,
       (SELECT COUNT(*) FROM findings WHERE review_status = 'pending_review') AS findings_awaiting_review,
       (SELECT COUNT(*) FROM research_runs WHERE status = 'completed') AS completed_runs,
       (SELECT COUNT(*) FROM research_runs WHERE status = 'partially_completed') AS partially_completed_runs,
       (SELECT COUNT(*) FROM research_runs WHERE status = 'failed') AS failed_runs`,
  );
  const recentRuns = await query(
    `SELECT r.id, r.company_id, c.company_name, r.status, r.progress_message,
       r.pages_visited, r.documents_discovered, r.documents_processed, r.findings_count,
       r.error_summary, r.warning_summary, r.created_at, r.completed_at
     FROM research_runs r JOIN companies c ON c.id = r.company_id
     ORDER BY r.created_at DESC LIMIT 8`,
  );
  response.json({ ...rows[0], recent_runs: recentRuns });
});

app.get('/api/companies/options', async (_request, response) => {
  const [industries, locations, focusAreas, turnoverBases] = await Promise.all([
    query('SELECT DISTINCT industry AS value FROM companies WHERE industry IS NOT NULL AND industry <> "" ORDER BY industry'),
    // Build suggestions from the supplied Indian workbooks. HQ cells include
    // international headquarters; only their explicitly Indian entries belong
    // in this location picker. City and Area are sourced from the Delhi/Chennai
    // sheets and retain their original locality detail.
    query(`SELECT DISTINCT original_value AS value FROM company_source_values
      WHERE source_column IN ('City', 'Area') AND TRIM(original_value) <> ''
      UNION
      SELECT DISTINCT original_value AS value FROM company_source_values
      WHERE source_column = 'HQ' AND original_value LIKE '%India%'
      ORDER BY value`),
    query('SELECT MIN(focus_area) AS value FROM company_focus_areas GROUP BY normalized_focus_area ORDER BY value'),
    query(`SELECT DISTINCT
        COALESCE(turnover_currency, CASE WHEN UPPER(COALESCE(turnover_original, "")) LIKE '%INR%'
          OR UPPER(COALESCE(turnover_original, "")) LIKE '%RS%'
          OR COALESCE(turnover_original, "") LIKE '%₹%' THEN 'INR' ELSE NULL END) AS turnover_currency,
        COALESCE(turnover_unit, CASE WHEN LOWER(COALESCE(turnover_original, "")) LIKE '%crore%'
          OR LOWER(COALESCE(turnover_original, "")) LIKE '% cr%' THEN 'crore'
          WHEN LOWER(COALESCE(turnover_original, "")) LIKE '%lakh%' THEN 'lakh'
          WHEN LOWER(COALESCE(turnover_original, "")) LIKE '%million%'
          OR LOWER(COALESCE(turnover_original, "")) LIKE '% mn%' THEN 'million'
          WHEN LOWER(COALESCE(turnover_original, "")) LIKE '%billion%' THEN 'billion' ELSE NULL END) AS turnover_unit
      FROM companies WHERE turnover_amount IS NOT NULL
      HAVING turnover_currency IS NOT NULL AND turnover_unit IS NOT NULL
      ORDER BY turnover_currency, turnover_unit`),
  ]);
  response.json({
    industries: industries.map((row) => row.value),
    locations: locations.map((row) => row.value),
    focus_areas: focusAreas.map((row) => row.value),
    turnover_bases: turnoverBases,
  });
});

app.get('/api/companies', async (request, response) => {
  const search = buildSearch(request.query);
  const { where, params: values, page, limit, sort, direction } = search;
  if (request.query.research_status) {
    if (!researchStatuses.has(String(request.query.research_status))) {
      return response.status(400).json({ error: 'research_status is not a supported research status.' });
    }
  }
  const fullValues = request.query.research_status
    ? [...values, String(request.query.research_status)]
    : values;
  const fullWhere = request.query.research_status
    ? `${where ? `${where} AND` : 'WHERE'} research_status = ?` : where;
  const totalRows = await query(
    `SELECT COUNT(*) AS total FROM companies c ${fullWhere}`,
    fullValues,
  );
  const companies = await query(
    `SELECT c.id, c.company_name, c.cin, c.industry, c.city, c.phase, c.region, c.headquarters,
      c.turnover_amount, c.turnover_currency, c.turnover_unit, c.turnover_original,
      c.official_website, c.official_website_verified_at, c.website_candidate, c.notes,
      c.contact_email, c.contact_phone, c.contact_name,
      c.contact_designation, c.research_status, c.last_researched_at, c.created_at,
      c.updated_at, (SELECT COUNT(*) FROM documents d WHERE d.company_id = c.id) AS document_count,
      (SELECT GROUP_CONCAT(f.focus_area ORDER BY f.focus_area SEPARATOR ', ') FROM company_focus_areas f WHERE f.company_id = c.id) AS focus_areas
     FROM companies c ${fullWhere} ORDER BY ${sort} ${direction}, c.id ASC LIMIT ? OFFSET ?`,
    [...fullValues, limit, (page - 1) * limit],
  );
  const companiesWithReadiness = companies.map((c) => {
    const isConfirmed = Boolean(c.official_website && c.official_website_verified_at);
    const isManualReview = !isConfirmed && Boolean(c.website_candidate || (c.notes && c.notes.includes('MANUAL_REVIEW')));
    const websiteReadiness = isConfirmed ? 'ready_to_research' : isManualReview ? 'needs_manual_review' : 'waiting_for_website';
    return { ...c, website_readiness: websiteReadiness };
  });
  const industries = await query(
    'SELECT DISTINCT industry FROM companies WHERE industry IS NOT NULL AND industry <> "" ORDER BY industry',
  );
  const locations = await query(`SELECT DISTINCT original_value AS value FROM company_source_values
    WHERE source_column IN ('City', 'Area') AND TRIM(original_value) <> ''
    UNION
    SELECT DISTINCT original_value AS value FROM company_source_values
    WHERE source_column = 'HQ' AND original_value LIKE '%India%'
    ORDER BY value`);
  const total = Number(totalRows[0].total) || 0;
  const focusAreas = await query('SELECT MIN(focus_area) AS focus_area FROM company_focus_areas GROUP BY normalized_focus_area ORDER BY focus_area');
  response.json({
    companies: companiesWithReadiness,
    industries: industries.map((row) => row.industry),
    locations: locations.map((row) => row.value),
    focus_areas: focusAreas.map((row) => row.focus_area),
    interpreted_filters: search.interpreted.filters,
    pagination: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

app.get('/api/companies/domain-summary', async (_request, response) => {
  const [summary] = await query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN official_website IS NOT NULL AND official_website != '' AND official_website_verified_at IS NOT NULL THEN 1 ELSE 0 END) AS ready_to_research,
      SUM(CASE WHEN (official_website IS NULL OR official_website = '' OR official_website_verified_at IS NULL) AND (website_candidate IS NOT NULL AND website_candidate != '' OR notes LIKE '%MANUAL_REVIEW%') THEN 1 ELSE 0 END) AS needs_manual_review,
      SUM(CASE WHEN (official_website IS NULL OR official_website = '') AND (website_candidate IS NULL OR website_candidate = '') AND (notes NOT LIKE '%MANUAL_REVIEW%' OR notes IS NULL) THEN 1 ELSE 0 END) AS waiting_for_website
    FROM companies
  `);
  response.json({
    total: Number(summary[0].total) || 0,
    ready_to_research: Number(summary[0].ready_to_research) || 0,
    needs_manual_review: Number(summary[0].needs_manual_review) || 0,
    waiting_for_website: Number(summary[0].waiting_for_website) || 0,
  });
});

app.post('/api/companies/bulk-confirm-websites', async (request, response) => {
  let items = [];
  if (Array.isArray(request.body?.confirmations)) {
    items = request.body.confirmations;
  } else if (Array.isArray(request.body?.company_ids)) {
    items = request.body.company_ids.map((id) => ({ id }));
  } else {
    return response.status(400).json({ error: 'Provide company_ids array or confirmations array.' });
  }
  if (!items.length) {
    return response.status(400).json({ error: 'No companies selected for confirmation.' });
  }
  const results = [];
  await transaction(async (connection) => {
    for (const item of items) {
      const companyId = parseId(item.id || item.company_id);
      const [existingRows] = await connection.execute(
        'SELECT id, company_name, official_website, website_candidate, notes FROM companies WHERE id = ? FOR UPDATE',
        [companyId],
      );
      if (!existingRows.length) {
        results.push({ company_id: companyId, status: 'error', error: 'Company not found.' });
        continue;
      }
      const existing = existingRows[0];
      const candidateUrl = item.website || existing.website_candidate || existing.official_website;
      if (!candidateUrl) {
        results.push({ company_id: companyId, company_name: existing.company_name, status: 'error', error: 'No website URL provided or available.' });
        continue;
      }
      let normalized;
      try {
        normalized = normalizeWebsite(candidateUrl);
      } catch (e) {
        results.push({ company_id: companyId, company_name: existing.company_name, status: 'error', error: e.message });
        continue;
      }
      const source = item.verification_source || item.source || normalized;
      const note = `Website verification: status=CONFIRMED; confidence=high; source=${source}; checked=${new Date().toISOString().slice(0, 10)}.`;
      await connection.execute(
        `UPDATE companies
         SET official_website = ?,
             website_candidate = NULL,
             official_website_verified_at = NOW(),
             notes = ?
         WHERE id = ?`,
        [normalized, note, companyId],
      );
      results.push({ company_id: companyId, company_name: existing.company_name, status: 'confirmed', official_website: normalized });
    }
  });
  const confirmedCount = results.filter((r) => r.status === 'confirmed').length;
  response.json({
    confirmed_count: confirmedCount,
    results,
  });
});

app.get('/api/companies/:id/source-values', async (request, response) => {
  const id = parseId(request.params.id);
  const rows = await query(
    `SELECT source_workbook, source_worksheet, source_row, source_column, original_value
     FROM company_source_values WHERE company_id = ? ORDER BY source_workbook, source_worksheet, source_row, id`, [id],
  );
  response.json({ source_values: rows });
});

app.post('/api/imports/scan', express.raw({ type: 'application/octet-stream', limit: maxImportBytes }), async (request, response) => {
    const { filename, sheets, sheet } = await loadImportFile(request);
    response.json({
      filename,
      sheets: sheets.map(({ name, headers }) => ({ name, headers })),
      selected_sheet: sheet.name,
      headers: sheet.headers,
      sample_rows: sheet.rows.slice(0, 5),
      suggested_mappings: suggestMappings(sheet.headers),
      import_fields: importFields,
    });
  });

app.post('/api/imports/preview', express.raw({ type: 'application/octet-stream', limit: maxImportBytes }), async (request, response) => {
    const { sheet } = await loadImportFile(request);
    let mappings;
    try {
      mappings = JSON.parse(String(request.headers['x-import-mappings'] || '{}'));
    } catch {
      return response.status(400).json({ error: 'Column mappings must be valid JSON.' });
    }
    validateImportMappings(sheet.headers, mappings);
    const rows = mapImportRows(sheet, mappings);
    const validNames = [...new Set(rows
      .filter((row) => !importRowErrors(row).length)
      .map((row) => normalizeCompanyName(row.mapped.company_name)))];
    const validCins = [...new Set(rows.map((row) => row.mapped.cin).filter(Boolean))];
    const matches = validNames.length || validCins.length
      ? await query(
        `SELECT c.id, c.company_name, c.normalized_name, c.cin, c.official_website,
           a.normalized_alias AS matched_alias
         FROM companies c LEFT JOIN company_aliases a ON a.company_id = c.id
         WHERE c.normalized_name IN (${validNames.map(() => '?').join(',') || 'NULL'}
         ) OR a.normalized_alias IN (${validNames.map(() => '?').join(',') || 'NULL'})
           OR c.cin IN (${validCins.map(() => '?').join(',') || 'NULL'})`,
        [...validNames, ...validNames, ...validCins],
      )
      : [];
    const byName = new Map(matches.map((company) => [company.normalized_name, company]));
    const byAlias = new Map(matches.filter((company) => company.matched_alias)
      .map((company) => [company.matched_alias, company]));
    const byCin = new Map(matches.filter((company) => company.cin).map((company) => [company.cin, company]));
    const seen = new Map();
    const previewRows = rows.map((row) => {
      const errors = importRowErrors(row);
      const normalized = normalizeCompanyName(row.mapped.company_name);
      const existing = (row.mapped.cin && byCin.get(row.mapped.cin))
        || byName.get(normalized) || byAlias.get(normalized) || null;
      const duplicateRow = !errors.length
        ? (seen.get(`name:${normalized}`) || (row.mapped.cin ? seen.get(`cin:${row.mapped.cin}`) : null))
        : null;
      if (!errors.length && !duplicateRow) {
        seen.set(`name:${normalized}`, row.row_number);
        if (row.mapped.cin) seen.set(`cin:${row.mapped.cin}`, row.row_number);
      }
      return {
        row_number: row.row_number,
        original: row.original,
        mapped: row.mapped,
        validation_errors: errors,
        matched_company: existing ? { id: existing.id, company_name: existing.company_name } : null,
        duplicate_of_row: duplicateRow || null,
        outcome: errors.length ? 'invalid' : duplicateRow ? 'duplicate_in_upload' : existing ? 'merge_existing' : 'create',
      };
    });
    response.json({
      row_count: previewRows.length,
      valid_rows: previewRows.filter((row) => !row.validation_errors.length).length,
      error_rows: previewRows.filter((row) => row.validation_errors.length).length,
      rows: previewRows,
    });
  });

app.post('/api/imports/confirm', express.raw({ type: 'application/octet-stream', limit: maxImportBytes }), async (request, response) => {
    const { filename, sheet } = await loadImportFile(request);
    let mappings;
    try {
      mappings = JSON.parse(String(request.headers['x-import-mappings'] || '{}'));
    } catch {
      return response.status(400).json({ error: 'Column mappings must be valid JSON.' });
    }
    validateImportMappings(sheet.headers, mappings);
    let resolutions;
    try {
      resolutions = JSON.parse(String(request.headers['x-import-resolutions'] || '{}'));
    } catch {
      return response.status(400).json({ error: 'Duplicate resolutions must be valid JSON.' });
    }
    if (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions)
      || Object.values(resolutions).some((value) => !['use_existing', 'skip'].includes(value))) {
      return response.status(400).json({ error: 'Duplicate resolutions must be use_existing or skip.' });
    }
    const rows = mapImportRows(sheet, mappings);
    const importResult = await transaction(async (connection) => {
      const [batch] = await connection.execute(
        `INSERT INTO import_batches (uploaded_filename, worksheet_name, field_mappings)
         VALUES (?, ?, ?)`,
        [filename, sheet.name, JSON.stringify(mappings)],
      );
      let imported = 0;
      let errors = 0;
      const seen = new Map();
      for (const row of rows) {
        const errorsForRow = importRowErrors(row);
        const name = errorsForRow.length ? null : validateCompanyName(row.mapped.company_name);
        const normalized = name ? normalizeCompanyName(name) : null;
        const duplicateInUpload = seen.get(`name:${normalized}`)
          || (row.mapped.cin ? seen.get(`cin:${row.mapped.cin}`) : null);
        const resolution = resolutions[String(row.row_number)] || 'use_existing';
        if (!duplicateInUpload && resolution !== 'skip') {
          seen.set(`name:${normalized}`, row.row_number);
          if (row.mapped.cin) seen.set(`cin:${row.mapped.cin}`, row.row_number);
        }
        let companyId = null;
        let outcome = 'invalid';
        if (name && resolution !== 'skip') {
          const [found] = await connection.execute(
            `SELECT id, company_name, normalized_name, cin, industry, city, contact_email,
               contact_phone, contact_name, contact_designation, priority, website_candidate
             FROM companies WHERE normalized_name = ?
               OR id IN (SELECT company_id FROM company_aliases WHERE normalized_alias = ?)
               OR (? <> '' AND cin = ?) LIMIT 1 FOR UPDATE`,
            [normalized, normalized, row.mapped.cin || '', row.mapped.cin || ''],
          );
          if (found.length) {
            companyId = found[0].id;
            outcome = duplicateInUpload ? 'duplicate_in_upload' : 'merged';
            await connection.execute(
              `UPDATE companies SET
                 cin = COALESCE(cin, NULLIF(?, '')),
                 industry = COALESCE(industry, NULLIF(?, '')),
                 city = COALESCE(city, NULLIF(?, '')),
                 contact_email = COALESCE(contact_email, NULLIF(?, '')),
                 contact_phone = COALESCE(contact_phone, NULLIF(?, '')),
                 contact_name = COALESCE(contact_name, NULLIF(?, '')),
                 contact_designation = COALESCE(contact_designation, NULLIF(?, '')),
                 priority = COALESCE(priority, NULLIF(?, '')),
                 website_candidate = COALESCE(website_candidate, NULLIF(?, ''))
               WHERE id = ?`,
              [
                row.mapped.cin || '', row.mapped.industry || '', row.mapped.city || '',
                row.mapped.contact_email || '', row.mapped.contact_phone || '',
                row.mapped.contact_name || '', row.mapped.contact_designation || '',
                row.mapped.priority || '', row.mapped.website_candidate || '', companyId,
              ],
            );
          } else {
            const [created] = await connection.execute(
              `INSERT INTO companies
                (company_name, normalized_name, cin, industry, city, website_candidate,
                 contact_email, contact_phone, contact_name, contact_designation, priority, data_origin)
               VALUES (?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
                 NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), 'manual_import')`,
              [
                name, normalized, row.mapped.cin || '', row.mapped.industry || '',
                row.mapped.city || '', row.mapped.website_candidate || '',
                row.mapped.contact_email || '', row.mapped.contact_phone || '',
                row.mapped.contact_name || '', row.mapped.contact_designation || '', row.mapped.priority || '',
              ],
            );
            companyId = created.insertId;
            outcome = 'created';
          }
        } else {
          outcome = name ? 'skipped' : 'invalid';
          if (!name) errors += 1;
        }
        const mappedData = { ...row.mapped };
        const [rowInsert] = await connection.execute(
          `INSERT INTO import_batch_rows
            (import_batch_id, \`row_number\`, original_data, mapped_data, validation_errors, outcome, company_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            batch.insertId, row.row_number, JSON.stringify(row.original), JSON.stringify(mappedData),
            JSON.stringify(errorsForRow), outcome, companyId,
          ],
        );
        if (companyId) {
          imported += 1;
          if (row.mapped.company_alias) {
            const alias = validateCompanyName(row.mapped.company_alias);
            const normalizedAlias = normalizeCompanyName(alias);
            if (normalizedAlias !== normalizeCompanyName(name)) {
              await connection.execute(
                `INSERT IGNORE INTO company_aliases (company_id, alias, normalized_alias)
                 VALUES (?, ?, ?)`,
                [companyId, alias, normalizedAlias],
              );
            }
          }
          const year = row.mapped.financial_year || null;
          let sourceDocumentId = null;
          if (row.mapped.source_url) {
            const urlHash = crypto.createHash('sha256').update(row.mapped.source_url).digest('hex');
            const [sourceDocument] = await connection.execute(
              `INSERT INTO documents
                (company_id, research_run_id, source_url, url_hash, title, file_type, document_type,
                 financial_year, publication_date, import_batch_row_id, processing_status)
               VALUES (?, NULL, ?, ?, ?, 'unknown', ?, ?, ?, ?, 'discovered')
               ON DUPLICATE KEY UPDATE
                 import_batch_row_id = COALESCE(import_batch_row_id, VALUES(import_batch_row_id)),
                 document_type = COALESCE(document_type, VALUES(document_type)),
                 financial_year = COALESCE(financial_year, VALUES(financial_year)),
                 publication_date = COALESCE(publication_date, VALUES(publication_date))`,
              [
                companyId, row.mapped.source_url, urlHash,
                row.mapped.source_title || row.mapped.source_url,
                row.mapped.source_document_type || null, year,
                row.mapped.publication_date || null, rowInsert.insertId,
              ],
            );
            sourceDocumentId = sourceDocument.insertId;
            if (!sourceDocumentId) {
              const [existingDocument] = await connection.execute(
                'SELECT id FROM documents WHERE company_id = ? AND url_hash = ?',
                [companyId, urlHash],
              );
              sourceDocumentId = existingDocument[0]?.id || null;
            }
          }
          for (const field of importFindingFields) {
            const value = row.mapped[field];
            if (!value) continue;
            const money = field.endsWith('_amount') ? parseMoney(value) : { numeric: null, currency: null, unit: null };
            const digest = crypto.createHash('sha256')
              .update([companyId, field, year || '', value, row.mapped.source_url || '', 'manual_import'].join('\n'))
              .digest('hex');
            await connection.execute(
              `INSERT IGNORE INTO findings
                (company_id, document_id, field_name, finding_value, original_value, finding_category,
                 numeric_value, currency, unit, relevant_focus_area, financial_year, source_url, supporting_excerpt,
                 extraction_method, provenance, import_batch_row_id, review_status, evidence_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual_import', ?, 'pending_review', ?)`,
              [
                companyId, sourceDocumentId, field, value, value,
                field.endsWith('_amount') ? 'financial' : 'programmatic',
                money.numeric, money.currency, money.unit,
                field === 'csr_focus_area' ? value : null,
                year, row.mapped.source_url || '',
                `Manually imported from spreadsheet row ${row.row_number}; no evidence excerpt was provided.`,
                rowInsert.insertId, digest,
              ],
            );
          }
        }
      }
      const status = errors ? 'completed_with_errors' : 'completed';
      await connection.execute(
        'UPDATE import_batches SET status = ?, imported_rows = ?, error_rows = ? WHERE id = ?',
        [status, imported, errors, batch.insertId],
      );
      return { id: batch.insertId, imported_rows: imported, error_rows: errors, status };
    });
    response.status(201).json({ import_batch: importResult });
  });

app.get('/api/company-domain-suggestions', async (request, response) => {
  const companyName = validateCompanyName(request.query.company_name);
  const registryPath = path.join(__dirname, '..', 'research', 'company_domains.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const normalizedName = normalizeCompanyName(companyName);
  const match = Object.entries(registry).find(([name, details]) => (
    details && typeof details === 'object'
      && [name, ...(Array.isArray(details.aliases) ? details.aliases : [])]
        .some((candidate) => normalizeCompanyName(candidate) === normalizedName)
  ));
  response.json({
    suggested_website: match ? normalizeWebsite(match[1].website) : null,
    source_url: match?.[1]?.source_url || null,
    verification_note: match?.[1]?.verification_note || null,
    requires_confirmation: Boolean(match),
  });
});

app.post('/api/companies', async (request, response) => {
  const input = companyInput(request.body || {});
  if (!input.website) {
    return response.status(400).json({
      error: 'A confirmed official website is required for manual company creation. If no reliable candidate is available, ask the researcher to provide one.',
    });
  }
  try {
    const result = await transaction(async (connection) => {
      const [created] = await connection.execute(
        `INSERT INTO companies
          (company_name, normalized_name, official_website, official_website_verified_at)
         VALUES (?, ?, ?, NOW())`,
        [
          input.name, input.normalizedName, input.website,
        ],
      );
      return { companyId: created.insertId };
    });
    const run = await createRun(result.companyId);
    if (!run.existing) enqueueResearch(run);
    const company = await getCompany(result.companyId);
    response.status(201).json({ company, research_run: { id: run.id, status: run.status } });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return response.status(409).json({ error: 'A company with this name already exists.' });
    }
    throw error;
  }
});

app.get('/api/companies/matches', async (request, response) => {
  const name = validateCompanyName(request.query.name);
  const normalizedName = normalizeCompanyName(name);
  const cin = typeof request.query.cin === 'string' ? request.query.cin.trim() : '';
  if (cin.length > 21) return response.status(400).json({ error: 'CIN must be 21 characters or fewer.' });
  const matches = await query(
    `SELECT id, company_name, cin, industry, official_website, research_status
     FROM companies
     WHERE normalized_name = ?
        OR id IN (SELECT company_id FROM company_aliases WHERE normalized_alias = ?)
        OR (? <> '' AND cin = ?)
     ORDER BY (normalized_name = ?) DESC, company_name LIMIT 10`,
    [normalizedName, normalizedName, cin, cin, normalizedName],
  );
  response.json({ matches });
});

app.get('/api/companies/:id', async (request, response) => {
  const id = parseId(request.params.id);
  const company = await getCompany(id);
  const [runs, documents, findings] = await Promise.all([
    query(
      `SELECT id, status, progress_message, pages_visited, documents_discovered,
         documents_processed, findings_count, error_summary, warning_summary, created_at, completed_at
       FROM research_runs WHERE company_id = ? ORDER BY created_at DESC LIMIT 50`,
      [id],
    ),
    query(
      `SELECT id, research_run_id, source_url, source_page_url, link_text, validation_result, title, file_type, document_type,
         (storage_name IS NOT NULL AND processing_status = 'processed') AS download_available,
         financial_year, publication_date, import_batch_row_id, processing_status,
         processing_error, downloaded_at, created_at
       FROM documents WHERE company_id = ? ORDER BY created_at DESC LIMIT 300`,
      [id],
    ),
    query(
      `SELECT id, research_run_id, document_id, field_name, finding_value, financial_year,
         COALESCE(original_value, finding_value) AS original_value,
         source_url, page_number, supporting_excerpt, extraction_method, finding_category,
         numeric_value, currency, unit, relevant_focus_area, provenance, import_batch_row_id,
         reviewer_identity, review_status, reviewer_notes, reviewed_at, created_at, updated_at
       FROM findings WHERE company_id = ? ORDER BY financial_year DESC, created_at DESC LIMIT 500`,
      [id],
    ),
  ]);
  response.json({ company, research_runs: runs, documents, findings });
});

app.patch('/api/companies/:id', async (request, response) => {
  const id = parseId(request.params.id);
  const current = await getCompany(id);
  const input = companyInput(request.body || {}, current);
  try {
    await query(
      `UPDATE companies SET company_name = ?, normalized_name = ?, industry = ?,
         cin = COALESCE(?, cin), city = ?, contact_email = ?, contact_phone = ?,
         contact_name = ?, contact_designation = ?,
         official_website_verified_at = IF(official_website <=> ? AND official_website_verified_at IS NOT NULL, official_website_verified_at, NOW()),
         official_website = ?, notes = ? WHERE id = ?`,
      [
        input.name, input.normalizedName, input.industry, input.cin, input.city,
        input.contactEmail, input.contactPhone, input.contactName, input.contactDesignation,
        input.website, input.website,
        input.notes, id,
      ],
    );
    response.json({ company: await getCompany(id) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return response.status(409).json({ error: 'A company with this name already exists.' });
    }
    throw error;
  }
});

app.delete('/api/companies/:id', async (request, response) => {
  const id = parseId(request.params.id);
  await getCompany(id);
  await query('DELETE FROM companies WHERE id = ?', [id]);
  response.status(204).end();
});

app.post('/api/companies/:id/research', async (request, response) => {
  if (request.body?.confirm_official_website !== true) {
    return response.status(400).json({ error: "Confirm the company's official website before starting research." });
  }
  const companyId = parseId(request.params.id);
  const run = await createRun(companyId);
  if (!run.existing) enqueueResearch(run);
  response.status(run.existing ? 200 : 202).json({ research_run: { id: run.id, status: run.status, already_active: run.existing } });
});

app.post('/api/research/batch', async (request, response) => {
  const companyIds = [...new Set((Array.isArray(request.body?.company_ids) ? request.body.company_ids : [])
    .map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))].slice(0, 25);
  if (!companyIds.length) return response.status(400).json({ error: 'Select at least one company.' });
  if (request.body?.confirm_official_websites !== true) {
    return response.status(400).json({ error: 'Confirm that the saved domains are official before starting this batch.' });
  }
  const results = [];
  for (const companyId of companyIds) {
    try {
      const rows = await query(
        'SELECT id, company_name, official_website, official_website_verified_at, research_status FROM companies WHERE id = ?', [companyId],
      );
      if (!rows.length) { results.push({ company_id: companyId, status: 'failed', message: 'Company not found.' }); continue; }
      if (!rows[0].official_website || !rows[0].official_website_verified_at) {
        results.push({
          company_id: companyId,
          company_name: rows[0].company_name,
          status: 'needs_domain',
          message: 'Confirm an official website with verification source before starting research.',
        });
        continue;
      }
      const run = await createRun(companyId);
      if (!run.existing) enqueueResearch(run);
      results.push({ company_id: companyId, company_name: rows[0].company_name, status: run.status, run_id: run.id, already_active: run.existing });
    } catch (error) {
      results.push({ company_id: companyId, status: error.status === 409 ? 'already_running' : 'failed', message: error.message });
    }
  }
  response.status(202).json({ results, summary: {
    queued: results.filter((item) => item.status === 'queued' && !item.already_active).length,
    needs_domain: results.filter((item) => item.status === 'needs_domain').length,
    already_running: results.filter((item) => item.already_active || item.status === 'already_running').length,
    failed: results.filter((item) => ['failed'].includes(item.status)).length,
  } });
});

app.post('/api/companies/:id/research/retry', async (request, response) => {
  if (request.body?.confirm_official_website !== true) {
    return response.status(400).json({ error: "Confirm the company's official website before retrying." });
  }
  const companyId = parseId(request.params.id);
  const run = await createRun(companyId);
  if (!run.existing) enqueueResearch(run);
  response.status(run.existing ? 200 : 202).json({ research_run: { id: run.id, status: run.status, already_active: run.existing } });
});

app.post('/api/research', async (request, response) => {
  if (request.body?.confirm_official_website !== true) {
    return response.status(400).json({ error: "Confirm the company's official website before starting research." });
  }
  const companyName = validateCompanyName(request.body?.companyName);
  const website = request.body?.website === undefined
    ? ''
    : normalizeWebsite(request.body.website);
  const normalized = normalizeCompanyName(companyName);
  const existing = await query(
    'SELECT id, company_name, official_website FROM companies WHERE normalized_name = ?',
    [normalized],
  );
  const company = existing.length
    ? await findOrCreateCompany(companyName, website || existing[0].official_website)
    : await findOrCreateCompany(companyName, website);
  if (!company.official_website || !company.official_website_verified_at) {
    return response.status(400).json({
      error: 'A confirmed official website is required. Add it to the company profile before starting research.',
    });
  }
  const run = await createRun(company.id);
  if (!run.existing) enqueueResearch(run);
  response.status(run.existing ? 200 : 202).json({ research_run: { id: run.id, status: run.status, already_active: run.existing } });
});

app.get('/api/research', async (request, response) => {
  const page = Number(request.query.page || 1);
  const limit = Number(request.query.limit || 20);
  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    return response.status(400).json({ error: 'page must be a positive whole number.' });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return response.status(400).json({ error: 'limit must be a whole number between 1 and 100.' });
  }
  const totalRows = await query('SELECT COUNT(*) AS total FROM research_runs');
  const researchRuns = await query(
    `SELECT r.id, r.company_id, c.company_name, c.official_website, r.status,
       r.progress_message, r.pages_visited, r.documents_discovered, r.documents_processed,
       r.findings_count, r.error_summary, r.warning_summary, r.created_at, r.started_at, r.completed_at,
       (SELECT COUNT(*) FROM research_run_documents rd WHERE rd.research_run_id = r.id) AS saved_documents,
       (SELECT COUNT(*) FROM research_run_findings rf
          JOIN findings f ON f.id = rf.finding_id
          WHERE rf.research_run_id = r.id AND f.review_status = 'pending_review') AS pending_findings,
       (SELECT COUNT(*) FROM research_run_findings rf
          JOIN findings f ON f.id = rf.finding_id
          WHERE rf.research_run_id = r.id AND f.review_status = 'approved') AS approved_findings,
       (SELECT COUNT(*) FROM research_run_findings rf
          JOIN findings f ON f.id = rf.finding_id
          WHERE rf.research_run_id = r.id AND f.review_status = 'rejected') AS rejected_findings
     FROM research_runs r
     JOIN companies c ON c.id = r.company_id
     ORDER BY r.created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, (page - 1) * limit],
  );
  const total = Number(totalRows[0].total) || 0;
  response.json({
    research_runs: researchRuns,
    pagination: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

app.get('/api/research/:id', async (request, response) => {
  const id = parseId(request.params.id);
  const rows = await query(
    `SELECT r.*, c.company_name, c.industry, c.official_website, c.notes
     FROM research_runs r
     JOIN companies c ON c.id = r.company_id WHERE r.id = ?`,
    [id],
  );
  if (!rows.length) return response.status(404).json({ error: 'Research run not found.' });
  const [documents, findings] = await Promise.all([
    query(
      `SELECT d.id, d.source_url, d.source_page_url, d.link_text, d.validation_result, d.title, d.file_type, d.document_type, d.financial_year,
         d.publication_date, d.import_batch_row_id, d.content_hash,
         (d.storage_name IS NOT NULL AND d.processing_status = 'processed') AS download_available,
         d.extracted_text, d.processing_status, d.processing_error, d.downloaded_at, d.created_at
       FROM research_run_documents rd
       JOIN documents d ON d.id = rd.document_id
       WHERE rd.research_run_id = ? ORDER BY d.title`,
      [id],
    ),
    query(
      `SELECT f.id, f.research_run_id, f.document_id, f.field_name, f.finding_value,
         COALESCE(f.original_value, f.finding_value) AS original_value, f.financial_year,
         f.source_url, f.page_number, f.supporting_excerpt, f.extraction_method,
         f.finding_category, f.numeric_value, f.currency, f.unit, f.relevant_focus_area,
         f.provenance, f.import_batch_row_id, f.reviewer_identity, f.review_status,
         f.reviewer_notes, f.reviewed_at, f.created_at, f.updated_at
       FROM research_run_findings rf
       JOIN findings f ON f.id = rf.finding_id
       WHERE rf.research_run_id = ?
       ORDER BY f.financial_year DESC, f.field_name, f.created_at`,
      [id],
    ),
  ]);
  const events = await query(
    `SELECT id, event_type, step, message, source_url, details, created_at
     FROM research_run_events WHERE research_run_id = ? ORDER BY created_at, id LIMIT 500`, [id],
  );
  response.json({ research_run: rows[0], company: {
    id: rows[0].company_id,
    company_name: rows[0].company_name,
    industry: rows[0].industry,
    official_website: rows[0].official_website,
    notes: rows[0].notes,
  }, documents, findings, events });
});

app.get('/api/research/:id/documents', async (request, response) => {
  const id = parseId(request.params.id);
  const runs = await query('SELECT id FROM research_runs WHERE id = ?', [id]);
  if (!runs.length) return response.status(404).json({ error: 'Research run not found.' });
  const rows = await query(
      `SELECT d.id, d.source_url, d.source_page_url, d.validation_result, d.title, d.file_type, d.document_type, d.financial_year,
       d.publication_date, d.import_batch_row_id,
       (d.storage_name IS NOT NULL AND d.processing_status = 'processed') AS download_available,
       d.processing_status, d.processing_error, d.downloaded_at, d.created_at
     FROM research_run_documents rd
     JOIN documents d ON d.id = rd.document_id
     WHERE rd.research_run_id = ? ORDER BY d.title`,
    [id],
  );
  response.json({ documents: rows });
});

app.get('/api/documents/:id', async (request, response) => {
  const id = parseId(request.params.id);
  const rows = await query(
    `SELECT id, company_id, research_run_id, source_url, source_page_url, validation_result, title, file_type, document_type,
       financial_year, publication_date, import_batch_row_id, content_hash, extracted_text, processing_status,
       processing_error, downloaded_at, created_at
     FROM documents WHERE id = ?`,
    [id],
  );
  if (!rows.length) return response.status(404).json({ error: 'Document not found.' });
  response.json({ document: rows[0] });
});

app.get('/api/documents/:id/download', async (request, response) => {
  const id = parseId(request.params.id);
  const rows = await query(
    `SELECT title, file_type, storage_name, processing_status FROM documents WHERE id = ?`, [id],
  );
  if (!rows.length) return response.status(404).json({ error: 'Document not found.' });
  const { title, file_type: fileType, storage_name: storageName, processing_status: processingStatus } = rows[0];
  if (!storageName || processingStatus !== 'processed') {
    return response.status(404).json({ error: 'No downloaded source file is available for this document.' });
  }
  const storageRoot = path.resolve(process.env.DOCUMENT_STORAGE_DIR || path.join(__dirname, '..', 'research', 'documents'));
  const filePath = path.resolve(storageRoot, storageName);
  if (!filePath.startsWith(`${storageRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return response.status(404).json({ error: 'The saved source file is no longer available.' });
  }
  const ext = path.extname(storageName).toLowerCase();
  if (!['.pdf', '.html', '.txt'].includes(ext)) {
    return response.status(404).json({ error: 'The saved file type is not available for download.' });
  }
  const filename = `${path.basename(String(title || 'csr-document'), path.extname(String(title || '')))
    .replace(/[^\p{L}\p{N}._ -]/gu, '').trim().slice(0, 100) || 'csr-document'}${ext}`;
  response.download(filePath, filename, (error) => {
    if (error && !response.headersSent) response.status(500).json({ error: 'Could not download the saved source file.' });
  });
});

app.get('/api/companies/:id/findings', async (request, response) => {
  const companyId = parseId(request.params.id);
  await getCompany(companyId);
  const findings = await query(
    `SELECT id, research_run_id, document_id, field_name, finding_value,
       COALESCE(original_value, finding_value) AS original_value, financial_year,
       source_url, page_number, supporting_excerpt, extraction_method, finding_category,
       numeric_value, currency, unit, relevant_focus_area, provenance, import_batch_row_id,
       reviewer_identity, review_status, reviewer_notes, reviewed_at, created_at, updated_at
     FROM findings WHERE company_id = ? ORDER BY financial_year DESC, created_at DESC`,
    [companyId],
  );
  response.json({ findings });
});

app.post('/api/companies/:id/findings', async (request, response) => {
  const companyId = parseId(request.params.id);
  const company = await getCompany(companyId);
  const field = request.body?.field_name;
  if (typeof field !== 'string' || !field.trim() || field.length > 120) {
    return response.status(400).json({ error: 'field_name must contain between 1 and 120 characters.' });
  }
  const fieldName = field.trim().toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '');
  if (!fieldName) return response.status(400).json({ error: 'field_name must contain letters or numbers.' });
  const value = 'Not found in reviewed sources';
  const excerpt = 'A researcher manually marked this information unavailable; no supporting source passage was found.';
  const digest = crypto.createHash('sha256')
    .update(`${fieldName}\n${value}\n${companyId}`)
    .digest('hex');
  const finding = await transaction(async (connection) => {
    const [insert] = await connection.execute(
      `INSERT IGNORE INTO findings
        (company_id, research_run_id, field_name, finding_value, original_value, source_url,
         supporting_excerpt, extraction_method, provenance, review_status, evidence_hash)
       SELECT ?, (SELECT id FROM research_runs WHERE company_id = ? ORDER BY created_at DESC LIMIT 1),
         ?, ?, ?, '', ?, 'manual', 'researcher_supplied', 'unavailable', ?`,
      [companyId, companyId, fieldName, value, value, excerpt, digest],
    );
    const [rows] = await connection.execute(
      'SELECT * FROM findings WHERE company_id = ? AND evidence_hash = ?',
      [companyId, digest],
    );
    if (rows[0]?.research_run_id) {
      await connection.execute(
        'INSERT IGNORE INTO research_run_findings (research_run_id, finding_id) VALUES (?, ?)',
        [rows[0].research_run_id, rows[0].id],
      );
    }
    if (insert.affectedRows) {
      await connection.execute(
        `INSERT INTO finding_review_history
          (finding_id, decision, previous_value, revised_value, reviewer_identity, reason)
         VALUES (?, 'unavailable', NULL, ?, NULL, ?)`,
        [rows[0].id, value, excerpt],
      );
    }
    return rows[0];
  });
  response.status(201).json({ finding });
});

app.get('/api/findings/:id/history', async (request, response) => {
  const id = parseId(request.params.id);
  const exists = await query('SELECT id FROM findings WHERE id = ?', [id]);
  if (!exists.length) return response.status(404).json({ error: 'Finding not found.' });
  const history = await query(
    `SELECT id, decision, previous_value, revised_value, previous_financial_year,
       revised_financial_year, reviewer_identity, reason, reviewed_at
     FROM finding_review_history WHERE finding_id = ? ORDER BY reviewed_at DESC, id DESC`,
    [id],
  );
  response.json({ history });
});

app.patch('/api/findings/:id/review', async (request, response) => {
  const id = parseId(request.params.id);
  const body = request.body || {};
  if (!reviewStatuses.has(body.review_status)) {
    return response.status(400).json({
      error: 'review_status must be pending_review, approved, rejected, or unavailable.',
    });
  }
  if (body.finding_value !== undefined
    && (typeof body.finding_value !== 'string' || body.finding_value.length > 10000)) {
    return response.status(400).json({ error: 'finding_value must be text of 10,000 characters or fewer.' });
  }
  if (body.financial_year !== undefined
    && body.financial_year !== null
    && (typeof body.financial_year !== 'string' || body.financial_year.length > 20)) {
    return response.status(400).json({ error: 'financial_year must be text of 20 characters or fewer.' });
  }
  if (body.reviewer_notes !== undefined
    && (typeof body.reviewer_notes !== 'string' || body.reviewer_notes.length > 10000)) {
    return response.status(400).json({ error: 'reviewer_notes must be text of 10,000 characters or fewer.' });
  }
  if (body.reviewer_identity !== undefined
    && (typeof body.reviewer_identity !== 'string' || body.reviewer_identity.length > 200)) {
    return response.status(400).json({ error: 'reviewer_identity must be text of 200 characters or fewer.' });
  }
  if (body.reason !== undefined
    && (typeof body.reason !== 'string' || body.reason.length > 10000)) {
    return response.status(400).json({ error: 'reason must be text of 10,000 characters or fewer.' });
  }
  if (body.finding_value !== undefined && !body.finding_value.trim()) {
    return response.status(400).json({ error: 'finding_value cannot be empty.' });
  }
  const finding = await transaction(async (connection) => {
    const [existingRows] = await connection.execute(
      `SELECT field_name, finding_value, financial_year, numeric_value, currency, unit,
         reviewer_notes, reviewer_identity
       FROM findings WHERE id = ? FOR UPDATE`,
      [id],
    );
    if (!existingRows.length) {
      const notFound = new Error('Finding not found.');
      notFound.status = 404;
      throw notFound;
    }
    const previous = existingRows[0];
    const revisedValue = body.finding_value === undefined ? previous.finding_value : body.finding_value.trim();
    const revisedYear = body.financial_year === undefined
      ? previous.financial_year
      : (body.financial_year.trim() || null);
    const reviewer = body.reviewer_identity === undefined
      ? previous.reviewer_identity
      : (body.reviewer_identity.trim() || null);
    const monetary = reviewedMoneyFields(previous.field_name, revisedValue, previous);
    await connection.execute(
      `UPDATE findings SET review_status = ?, finding_value = ?, financial_year = ?,
         numeric_value = ?, currency = ?, unit = ?, reviewer_notes = ?,
         reviewer_identity = ?, reviewed_at = NOW() WHERE id = ?`,
      [
        body.review_status,
        revisedValue,
        revisedYear,
        monetary.numeric,
        monetary.currency,
        monetary.unit,
        body.reviewer_notes === undefined ? previous.reviewer_notes : body.reviewer_notes,
        reviewer,
        id,
      ],
    );
    await connection.execute(
      `INSERT INTO finding_review_history
        (finding_id, decision, previous_value, revised_value, previous_financial_year,
         revised_financial_year, reviewer_identity, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, body.review_status, previous.finding_value, revisedValue, previous.financial_year,
        revisedYear, reviewer, body.reason ?? body.reviewer_notes ?? null,
      ],
    );
    const [updated] = await connection.execute('SELECT * FROM findings WHERE id = ?', [id]);
    return updated[0];
  });
  response.json({ finding });
});

app.use((request, response) => {
  response.status(404).json({ error: 'API endpoint not found.' });
});

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return response.status(400).json({ error: 'Request body must contain valid JSON.' });
  }
  const status = Number(error.status) || (error.code === 'DATABASE_NOT_CONFIGURED' ? 503 : 500);
  if (status >= 500) console.error(`API request failed: ${error.message}`);
  const message = status >= 500
    ? (error.code === 'DATABASE_NOT_CONFIGURED'
      ? error.message
      : 'The request could not be completed. Check the database setup and try again.')
    : error.message;
  response.status(status).json({ error: message });
});

if (require.main === module) {
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`CSR research API listening on http://localhost:${port}`);
    if (isDatabaseConfigured()) {
      void recoverInterruptedRuns().catch((error) => {
        console.error(`Could not recover interrupted research runs: ${error.message}`);
      });
    }
  });
  const shutdown = () => {
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { app };
