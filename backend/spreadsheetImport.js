'use strict';

const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const projectRoot = path.dirname(__dirname);
const parserPath = path.join(__dirname, 'parse_spreadsheet.py');
const importFields = [
  'company_name',
  'company_alias',
  'cin',
  'industry',
  'city',
  'contact_name',
  'contact_designation',
  'contact_email',
  'contact_phone',
  'website_candidate',
  'priority',
  'financial_year',
  'source_url',
  'source_title',
  'source_document_type',
  'publication_date',
  'csr_obligation_amount',
  'csr_expenditure_amount',
  'unspent_csr_amount',
  'csr_focus_area',
  'csr_project',
  'csr_implementation_partner',
  'csr_committee',
  'csr_policy',
  'csr_observation',
];

const headerAliases = {
  company_name: ['company', 'company_name', 'company name', 'name', 'organization', 'organisation', 'corporate name'],
  company_alias: ['alias', 'company alias', 'alternate name', 'alternative company name'],
  cin: ['cin', 'corporate identification number', 'company identification number'],
  industry: ['industry', 'sector', 'business sector'],
  city: ['city', 'headquarters', 'headquarters city', 'location', 'hq', 'hq city'],
  contact_name: ['contact name', 'contact person', 'csr head', 'csr head contact person'],
  contact_designation: ['designation', 'contact designation', 'csr designation'],
  contact_email: ['email', 'contact email', 'email address', 'csr email', 'csr email link'],
  contact_phone: ['phone', 'telephone', 'contact number', 'mobile'],
  website_candidate: ['website', 'official website', 'url', 'domain', 'website url'],
  priority: ['priority', 'research priority', 'priority tier'],
  financial_year: ['financial year', 'financial_year', 'fy', 'year'],
  source_url: ['source url', 'source link', 'evidence url', 'report url'],
  source_title: ['source title', 'report title', 'document title'],
  source_document_type: ['document type', 'source type', 'report type'],
  publication_date: ['publication date', 'published on', 'date published'],
  csr_obligation_amount: ['csr obligation', 'csr obligation amount', 'required csr spend'],
  csr_expenditure_amount: ['csr expenditure', 'csr expenditure amount', 'csr spend', 'csr spending'],
  unspent_csr_amount: ['unspent csr', 'unspent csr amount'],
  csr_focus_area: ['csr focus area', 'csr focus areas', 'focus area', 'focus areas', 'primary csr themes'],
  csr_project: ['csr project', 'csr projects', 'csr initiative', 'csr initiatives'],
  csr_implementation_partner: ['implementation partner', 'implementing partner'],
  csr_committee: ['csr committee'],
  csr_policy: ['csr policy', 'csr policy details'],
  csr_observation: ['csr notes', 'csr observations', 'csr details', 'csr information'],
};

function normalizeHeader(header) {
  return String(header || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, ' ').trim();
}

function suggestMappings(headers) {
  const aliases = new Map();
  const usedFields = new Set();
  for (const [field, names] of Object.entries(headerAliases)) {
    for (const name of names) aliases.set(normalizeHeader(name), field);
  }
  return Object.fromEntries(headers.map((header) => {
    const field = aliases.get(normalizeHeader(header)) || '';
    if (!field || usedFields.has(field)) return [header, ''];
    usedFields.add(field);
    return [header, field];
  }));
}

function parseSpreadsheet(buffer, filename) {
  const extension = path.extname(filename).toLowerCase();
  if (!['.csv', '.xls', '.xlsx'].includes(extension)) {
    throw Object.assign(new Error('Upload a CSV, XLS, or XLSX workbook.'), { status: 400 });
  }
  const python = process.env.PYTHON_EXECUTABLE
    || (() => {
      const venvPython = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
      return fs.existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3');
    })();
  return new Promise((resolve, reject) => {
    const child = spawn(python, [parserPath, extension], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => reject(new Error(
      `Could not start the spreadsheet parser. Check PYTHON_EXECUTABLE and install requirements.txt. ${error.code || ''}`.trim(),
    )));
    child.once('close', (code) => {
      if (code !== 0) {
        let message = stderr.trim() || 'Spreadsheet parsing failed.';
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) message = parsed.error;
        } catch {
          // The Python process may fail before it can produce its JSON response.
        }
        reject(Object.assign(new Error(message), { status: 400 }));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) throw new Error(parsed.error);
        resolve(parsed.sheets);
      } catch (error) {
        reject(Object.assign(new Error(`Could not read spreadsheet: ${error.message}`), { status: 400 }));
      }
    });
    child.stdin.end(buffer);
  });
}

module.exports = { importFields, parseSpreadsheet, suggestMappings };
