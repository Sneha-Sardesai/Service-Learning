'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { importFields, parseSpreadsheet, suggestMappings } = require('../spreadsheetImport');
const { parseMoney } = require('../money');

test('CSV parsing preserves row values and proposes mappings without database writes', async () => {
  const [sheet] = await parseSpreadsheet(
    Buffer.from('Company Name,City,CSR Expenditure,Source URL\nExample Ltd,Delhi,"INR 2.5 crore",https://example.test/report.pdf\n'),
    'research.csv',
  );
  assert.deepEqual(sheet.headers, ['Company Name', 'City', 'CSR Expenditure', 'Source URL']);
  assert.equal(sheet.rows[0]['Company Name'], 'Example Ltd');
  assert.equal(sheet.rows[0]['CSR Expenditure'], 'INR 2.5 crore');
  assert.deepEqual(suggestMappings(sheet.headers), {
    'Company Name': 'company_name',
    City: 'city',
    'CSR Expenditure': 'csr_expenditure_amount',
    'Source URL': 'source_url',
  });
  assert.ok(importFields.includes('financial_year'));
});

test('CSV parsing disambiguates blank and duplicate headers', async () => {
  const [sheet] = await parseSpreadsheet(
    Buffer.from('Company,Amount,Amount,\nExample Ltd,1,2,extra\n'),
    'duplicate-headers.csv',
  );
  assert.deepEqual(sheet.headers, ['Company', 'Amount', 'Amount (2)', 'Column 4']);
  assert.equal(sheet.rows[0]['Amount (2)'], '2');
  assert.equal(sheet.rows[0]['Column 4'], 'extra');
});

test('XLSX workbooks expose worksheet names and values', async () => {
  const root = path.join(__dirname, '..', '..');
  const venvPython = path.join(root, '.venv', 'Scripts', 'python.exe');
  const python = fs.existsSync(venvPython) ? venvPython : 'python';
  const generated = spawnSync(python, ['-c', [
    'from io import BytesIO',
    'import base64',
    'from openpyxl import Workbook',
    'workbook = Workbook()',
    'sheet = workbook.active',
    'sheet.title = "Companies"',
    'sheet.append(["Company Name", "Industry"])',
    'sheet.append(["Example Ltd", "₹ 2 crore"])',
    'output = BytesIO()',
    'workbook.save(output)',
    'print(base64.b64encode(output.getvalue()).decode())',
  ].join('; ')], { maxBuffer: 5 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr.toString());
  const [sheet] = await parseSpreadsheet(Buffer.from(generated.stdout.toString().trim(), 'base64'), 'companies.xlsx');
  assert.equal(sheet.name, 'Companies');
  assert.equal(sheet.rows[0]['Company Name'], 'Example Ltd');
  assert.equal(sheet.rows[0].Industry, '₹ 2 crore');
});

test('real workbook contact, location, priority, and themes headers are suggested safely', () => {
  assert.deepEqual(suggestMappings([
    'Company', 'HQ', 'CSR Head / Contact Person', 'CSR Email Link', 'Priority Tier',
    'Primary CSR Themes', 'Turnover',
  ]), {
    Company: 'company_name',
    HQ: 'city',
    'CSR Head / Contact Person': 'contact_name',
    'CSR Email Link': 'contact_email',
    'Priority Tier': 'priority',
    'Primary CSR Themes': 'csr_focus_area',
    Turnover: '',
  });
});

test('mapping suggestions leave duplicate semantic fields unmapped', () => {
  const mappings = suggestMappings(['CSR Focus Areas', 'Primary CSR Themes']);
  assert.equal(mappings['CSR Focus Areas'], 'csr_focus_area');
  assert.equal(mappings['Primary CSR Themes'], '');
});

test('spreadsheet parser rejects unsupported file extensions', async () => {
  assert.throws(
    () => parseSpreadsheet(Buffer.from('input'), 'research.xlsm'),
    /CSV, XLS, or XLSX/,
  );
});

test('CSR monetary values preserve decimal precision, currency, and units', () => {
  assert.deepEqual(parseMoney('INR 1,234.5678 crore'), {
    numeric: '1234.5678',
    currency: 'INR',
    unit: 'crore',
  });
  assert.equal(parseMoney('₹ 0 lakh').numeric, '0');
  assert.equal(parseMoney('99.12345').numeric, null);
});
