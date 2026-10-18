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
} = require('./database');
const {
  createRun,
  executeResearchRun,
  findOrCreateCompany,
  recoverInterruptedRuns,
} = require('./researchWorkflow');
const { normalizeCompanyName, normalizeWebsite, validateCompanyName } = require('./validation');

const app = express();
const port = Number(process.env.PORT || 5000);
const reviewStatuses = new Set(['pending_review', 'approved', 'rejected', 'unavailable']);
const researchStatuses = new Set(['not_started', 'queued', 'running', 'completed', 'partially_completed', 'failed']);

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

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
  const notes = body.notes === undefined ? existing.notes : body.notes;
  const websiteInput = body.official_website === undefined
    ? existing.official_website
    : body.official_website;
  const website = websiteInput ? normalizeWebsite(websiteInput) : null;
  if (website && website !== existing.official_website && body.confirm_official_website !== true) {
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
  return {
    name,
    normalizedName: normalizeCompanyName(name),
    industry: typeof industry === 'string' ? industry.trim() || null : null,
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

app.get('/api/companies', async (request, response) => {
  const clauses = [];
  const values = [];
  if (request.query.q) {
    clauses.push('company_name LIKE ?');
    values.push(`%${String(request.query.q).slice(0, 200)}%`);
  }
  if (request.query.industry) {
    clauses.push('industry = ?');
    values.push(String(request.query.industry).slice(0, 160));
  }
  if (request.query.research_status) {
    if (!researchStatuses.has(String(request.query.research_status))) {
      return response.status(400).json({ error: 'research_status is not a supported research status.' });
    }
    clauses.push('research_status = ?');
    values.push(String(request.query.research_status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const page = Number(request.query.page || 1);
  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    return response.status(400).json({ error: 'page must be a positive whole number.' });
  }
  const limit = 50;
  const totalRows = await query(
    `SELECT COUNT(*) AS total FROM companies ${where}`,
    values,
  );
  const companies = await query(
    `SELECT id, company_name, industry, official_website, research_status,
      last_researched_at, created_at, updated_at,
      (SELECT COUNT(*) FROM documents d WHERE d.company_id = companies.id) AS document_count
     FROM companies ${where} ORDER BY company_name LIMIT ? OFFSET ?`,
    [...values, limit, (page - 1) * limit],
  );
  const industries = await query(
    'SELECT DISTINCT industry FROM companies WHERE industry IS NOT NULL AND industry <> "" ORDER BY industry',
  );
  const total = Number(totalRows[0].total) || 0;
  response.json({
    companies,
    industries: industries.map((row) => row.industry),
    pagination: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) },
  });
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
    requires_confirmation: Boolean(match),
  });
});

app.post('/api/companies', async (request, response) => {
  const input = companyInput(request.body || {});
  try {
    const result = await query(
      `INSERT INTO companies (company_name, normalized_name, industry, official_website, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [input.name, input.normalizedName, input.industry, input.website, input.notes],
    );
    response.status(201).json({ company: await getCompany(result.insertId) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return response.status(409).json({ error: 'A company with this name already exists.' });
    }
    throw error;
  }
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
      `SELECT id, research_run_id, source_url, title, file_type, processing_status,
         processing_error, downloaded_at, created_at
       FROM documents WHERE company_id = ? ORDER BY created_at DESC LIMIT 300`,
      [id],
    ),
    query(
      `SELECT id, research_run_id, document_id, field_name, finding_value, financial_year,
         COALESCE(original_value, finding_value) AS original_value,
         source_url, page_number, supporting_excerpt, extraction_method, review_status,
         reviewer_notes, reviewed_at, created_at, updated_at
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
         official_website = ?, notes = ? WHERE id = ?`,
      [input.name, input.normalizedName, input.industry, input.website, input.notes, id],
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
  const company = await getCompany(companyId);
  const run = await createRun(companyId);
  run.companyName = company.company_name;
  response.status(202).json({ research_run: { id: run.id, status: 'queued' } });
  void executeResearchRun(run).catch((error) => {
    console.error(`Research run ${run.id} failed: ${error.message}`);
  });
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
  if (!company.official_website) {
    return response.status(400).json({
      error: 'A confirmed official website is required. Add it to the company profile before starting research.',
    });
  }
  const run = await createRun(company.id);
  run.companyName = company.company_name;
  response.status(202).json({ research_run: { id: run.id, status: 'queued' } });
  void executeResearchRun(run).catch((error) => {
    console.error(`Research run ${run.id} failed: ${error.message}`);
  });
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
      `SELECT d.id, d.source_url, d.title, d.file_type, d.content_hash, d.storage_name,
         d.processing_status, d.processing_error, d.downloaded_at, d.created_at
       FROM research_run_documents rd
       JOIN documents d ON d.id = rd.document_id
       WHERE rd.research_run_id = ? ORDER BY d.title`,
      [id],
    ),
    query(
      `SELECT f.id, f.research_run_id, f.document_id, f.field_name, f.finding_value,
         COALESCE(f.original_value, f.finding_value) AS original_value, f.financial_year,
         f.source_url, f.page_number, f.supporting_excerpt, f.extraction_method,
         f.review_status, f.reviewer_notes, f.reviewed_at, f.created_at, f.updated_at
       FROM research_run_findings rf
       JOIN findings f ON f.id = rf.finding_id
       WHERE rf.research_run_id = ?
       ORDER BY f.financial_year DESC, f.field_name, f.created_at`,
      [id],
    ),
  ]);
  response.json({ research_run: rows[0], company: {
    id: rows[0].company_id,
    company_name: rows[0].company_name,
    industry: rows[0].industry,
    official_website: rows[0].official_website,
    notes: rows[0].notes,
  }, documents, findings });
});

app.get('/api/research/:id/documents', async (request, response) => {
  const id = parseId(request.params.id);
  const runs = await query('SELECT id FROM research_runs WHERE id = ?', [id]);
  if (!runs.length) return response.status(404).json({ error: 'Research run not found.' });
  const rows = await query(
    `SELECT d.id, d.source_url, d.title, d.file_type, d.processing_status, d.processing_error,
       d.downloaded_at, d.created_at
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
    `SELECT id, company_id, research_run_id, source_url, title, file_type, content_hash,
       extracted_text, processing_status, processing_error, downloaded_at, created_at
     FROM documents WHERE id = ?`,
    [id],
  );
  if (!rows.length) return response.status(404).json({ error: 'Document not found.' });
  response.json({ document: rows[0] });
});

app.get('/api/companies/:id/findings', async (request, response) => {
  const companyId = parseId(request.params.id);
  await getCompany(companyId);
  const findings = await query(
    `SELECT id, research_run_id, document_id, field_name, finding_value,
       COALESCE(original_value, finding_value) AS original_value, financial_year,
       source_url, page_number, supporting_excerpt, extraction_method, review_status,
       reviewer_notes, reviewed_at, created_at, updated_at
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
  await query(
    `INSERT IGNORE INTO findings
      (company_id, research_run_id, field_name, finding_value, original_value, source_url,
       supporting_excerpt, extraction_method, review_status, evidence_hash)
     SELECT ?, (SELECT id FROM research_runs WHERE company_id = ? ORDER BY created_at DESC LIMIT 1),
       ?, ?, ?, '', ?, 'manual', 'unavailable', ?`,
    [companyId, companyId, fieldName, value, value, excerpt, digest],
  );
  const rows = await query(
    'SELECT * FROM findings WHERE company_id = ? AND evidence_hash = ?',
    [companyId, digest],
  );
  if (rows[0]?.research_run_id) {
    await query(
      'INSERT IGNORE INTO research_run_findings (research_run_id, finding_id) VALUES (?, ?)',
      [rows[0].research_run_id, rows[0].id],
    );
  }
  response.status(201).json({ finding: rows[0] });
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
  if (body.finding_value !== undefined && !body.finding_value.trim()) {
    return response.status(400).json({ error: 'finding_value cannot be empty.' });
  }
  const existing = await query('SELECT id FROM findings WHERE id = ?', [id]);
  if (!existing.length) return response.status(404).json({ error: 'Finding not found.' });
  const notes = body.reviewer_notes === undefined ? null : body.reviewer_notes;
  const updated = await query(
    `UPDATE findings SET review_status = ?, finding_value = COALESCE(?, finding_value),
       financial_year = COALESCE(?, financial_year), reviewer_notes = COALESCE(?, reviewer_notes),
       reviewed_at = NOW() WHERE id = ?`,
    [
      body.review_status,
      body.finding_value === undefined ? null : body.finding_value.trim(),
      body.financial_year === undefined ? null : body.financial_year,
      notes,
      id,
    ],
  );
  const finding = await query('SELECT * FROM findings WHERE id = ?', [id]);
  response.json({ finding: finding[0] });
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
