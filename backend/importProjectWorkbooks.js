'use strict';

// Imports only the three source workbooks shipped with this project. It never
// starts or calls the research/crawling pipeline.
const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { parseSpreadsheet } = require('./spreadsheetImport');
const { normalizeCompanyName } = require('./validation');
const { parseMoney } = require('./money');
const { focusAreaKey, splitFocusAreas } = require('./companyFocusAreas');
const { transaction, closePool } = require('./database');

const root = path.join(__dirname, '..');
// Shared across all three workbook transactions so companies appearing in
// more than one source retain the union of their focus areas.
const focusRebuiltCompanyIds = new Set();
const files = [
  'Hinjewadi CSR data.xlsx',
  'CSR_Delhi_NCR_Companies_50_Completed Work.xlsx',
  'Akshar_Bharati_Chennai_CSR_Companies.xlsx',
];
const clean = (value) => value == null ? '' : String(value).trim();
const header = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pick = (row, aliases) => {
  const wanted = new Set(aliases.map(header));
  const key = Object.keys(row).find((name) => wanted.has(header(name)));
  return key ? clean(row[key]) : '';
};
function mapRow(row) {
  const company_name = pick(row, ['Company', 'Company Name']);
  const budget = pick(row, ['CSR Budget / Amount Spent']);
  const turnover = pick(row, ['Turnover']);
  const headquarters = pick(row, ['HQ', 'Headquarters']);
  return {
    company_name,
    industry: pick(row, ['Industry']),
    city: pick(row, ['City', 'Area']) || (/\bIndia\b/i.test(headquarters) ? headquarters : ''),
    headquarters,
    phase: pick(row, ['Phase']),
    contact_name: pick(row, ['CSR Head', 'CSR Head / Contact Person']),
    contact_designation: pick(row, ['Designation']),
    contact_email: pick(row, ['CSR Email Link']),
    priority: pick(row, ['Priority Tier', 'Priority']),
    focus_areas: splitFocusAreas(pick(row, ['CSR Focus Areas']), pick(row, ['Primary CSR Themes'])),
    turnover_original: turnover,
    turnover: parseMoney(turnover),
    // This header is explicitly ambiguous: preserve it as provenance and do not
    // classify it as actual expenditure or an obligation.
    ambiguous_csr_value: budget,
  };
}

async function importWorkbook(filename) {
  let sheets;
  const jsonPath = process.argv[2];
  if (jsonPath) {
    const bundle = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    const source = bundle.find((item) => item.file === filename);
    sheets = (source?.sheets || []).map((sheet) => {
      const orderedKeys = Object.keys(sheet.rows[0] || {}).sort((a, b) => Number(a) - Number(b));
      const headers = orderedKeys.map((key) => clean(sheet.rows[0]?.[key]));
      const disambiguated = headers.map((name, index) => name || `Column ${index + 1}`);
      const counts = new Map();
      const uniqueHeaders = disambiguated.map((name) => {
        const n = (counts.get(name) || 0) + 1; counts.set(name, n); return n === 1 ? name : `${name} (${n})`;
      });
      const records = sheet.rows.slice(1).map((row) => Object.fromEntries(uniqueHeaders.map((name, index) => [name, row[String(orderedKeys[index])] ?? null])));
      return { name: sheet.name, headers: uniqueHeaders, rows: records };
    });
  } else {
    const bytes = await fs.readFile(path.join(root, filename));
    sheets = await parseSpreadsheet(bytes, filename);
  }
  const report = { workbook: filename, source_rows: 0, unique_companies: 0, created: 0, updated: 0, merged_duplicates: 0, skipped: 0, errors: [] };
  const identities = new Set();
  const rows = [];
  for (const sheet of sheets) {
    // Notes and other non-company worksheets are inspected and reported, but
    // their free-form prose is not converted into company records.
    const companyHeader = sheet.headers.some((name) => ['company', 'company name'].includes(header(name)));
    if (!companyHeader) { report.skipped += sheet.rows.length; continue; }
    const sourceRows = sheet.rows.map((row, index) => ({ row, index }))
      .filter(({ row }) => Object.values(row).some((value) => clean(value)));
    report.source_rows += sourceRows.length;
    for (const { row, index } of sourceRows) {
      const mapped = mapRow(row);
      if (!mapped.company_name) { report.skipped += 1; continue; }
      const key = normalizeCompanyName(mapped.company_name);
      if (identities.has(key)) report.merged_duplicates += 1;
      identities.add(key);
      rows.push({ sheet: sheet.name, rowNumber: index + 2, original: row, mapped, key });
    }
  }
  report.unique_companies = identities.size;
  const focusResetThisWorkbook = new Set();
  await transaction(async (connection) => {
    for (const item of rows) {
      const [existing] = await connection.execute('SELECT * FROM companies WHERE normalized_name = ? FOR UPDATE', [item.key]);
      let companyId;
      if (!existing.length) {
        const m = item.mapped;
        const t = m.turnover;
        const [result] = await connection.execute(
          `INSERT INTO companies (company_name, normalized_name, industry, city, phase, headquarters,
             contact_name, contact_designation, contact_email, priority, turnover_amount, turnover_currency,
             turnover_unit, turnover_original, data_origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual_import')`,
          [m.company_name, item.key, m.industry || null, m.city || null, m.phase || null, m.headquarters || null,
            m.contact_name || null, m.contact_designation || null, m.contact_email || null, m.priority || null,
            t.numeric, t.currency, t.unit, m.turnover_original || null],
        );
        companyId = result.insertId;
        report.created += 1;
      } else {
        companyId = existing[0].id;
        const current = existing[0];
        const m = item.mapped;
        const t = m.turnover;
        const updates = {
          industry: m.industry, city: m.city, phase: m.phase, headquarters: m.headquarters,
          contact_name: m.contact_name, contact_designation: m.contact_designation, contact_email: m.contact_email,
          priority: m.priority,
        };
        const sets = []; const values = [];
        // The original importer copied every HQ into city. Keep an HQ in the
        // city field only when the source identifies it as Indian; the full HQ
        // remains available in its own canonical field and source provenance.
        if (current.city && current.headquarters && current.city === current.headquarters
          && !/\bIndia\b/i.test(current.headquarters) && !m.city) sets.push('city = NULL');
        for (const [column, value] of Object.entries(updates)) if (!current[column] && value) { sets.push(`${column} = ?`); values.push(value); }
        if (current.turnover_amount == null && t.numeric != null) {
          sets.push('turnover_amount = ?', 'turnover_currency = ?', 'turnover_unit = ?', 'turnover_original = ?');
          values.push(t.numeric, t.currency, t.unit, m.turnover_original);
        } else if (t.numeric != null && String(current.turnover_amount) === String(t.numeric)
          && current.turnover_original === m.turnover_original) {
          // Repair parsed metadata only when the stored number and source text agree.
          if (!current.turnover_currency && t.currency) { sets.push('turnover_currency = ?'); values.push(t.currency); }
          if (!current.turnover_unit && t.unit) { sets.push('turnover_unit = ?'); values.push(t.unit); }
        }
        if (sets.length) { await connection.execute(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`, [...values, companyId]); report.updated += 1; }
        // A match to a previously imported company is a normal idempotent merge,
        // not another duplicate-source row. Duplicate rows are counted above.
      }
      // Rebuild structured focus areas from the workbook cells on import. The
      // verbatim source cells remain in company_source_values for provenance.
      if (!focusRebuiltCompanyIds.has(companyId) && !focusResetThisWorkbook.has(companyId)) {
        await connection.execute('DELETE FROM company_focus_areas WHERE company_id = ?', [companyId]);
        focusResetThisWorkbook.add(companyId);
      }
      for (const field of Object.keys(item.original)) {
        const value = clean(item.original[field]);
        if (value) await connection.execute(
          `INSERT INTO company_source_values (company_id, source_workbook, source_worksheet, source_row, source_column, original_value)
           VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE original_value = VALUES(original_value)`,
          [companyId, filename, item.sheet, item.rowNumber, field, value],
        );
      }
      for (const area of item.mapped.focus_areas) await connection.execute(
        `INSERT IGNORE INTO company_focus_areas (company_id, focus_area, normalized_focus_area, source_value)
         VALUES (?, ?, ?, ?)`, [companyId, area, focusAreaKey(area), area],
      );
    }
  });
  for (const companyId of focusResetThisWorkbook) focusRebuiltCompanyIds.add(companyId);
  return report;
}

(async () => {
  const reports = [];
  for (const filename of files) {
    try { reports.push(await importWorkbook(filename)); }
    catch (error) { reports.push({ workbook: filename, errors: [error.message] }); }
  }
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  await closePool();
  if (reports.some((report) => report.errors?.length)) process.exitCode = 1;
})().catch(async (error) => { process.stderr.write(`${error.message}\n`); await closePool(); process.exitCode = 1; });
