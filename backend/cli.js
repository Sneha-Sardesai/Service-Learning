'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { isDatabaseConfigured } = require('./database');
const { createRun, executeResearchRun, findOrCreateCompany } = require('./researchWorkflow');
const { runResearch } = require('./researchService');
const { normalizeCompanyName, normalizeWebsite, validateCompanyName } = require('./validation');

function registryWebsite(companyName) {
  const registryPath = path.join(__dirname, '..', 'research', 'company_domains.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const target = normalizeCompanyName(companyName);
  for (const [name, details] of Object.entries(registry)) {
    if ([name, ...(details.aliases || [])].some((candidate) => normalizeCompanyName(candidate) === target)) {
      return details.website;
    }
  }
  return '';
}

async function main() {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt) => new Promise((resolve) => terminal.question(prompt, resolve));
  try {
    console.log('========================================');
    console.log('       CSR COMPANY RESEARCH TOOL');
    console.log('========================================');
    const companyName = validateCompanyName(await ask('\nEnter company name: '));
    const configuredWebsite = registryWebsite(companyName);
    let suppliedWebsite = (await ask('Enter its confirmed official website (leave blank to check the sample registry): ')).trim();
    if (!suppliedWebsite && configuredWebsite) {
      console.log(`Configured sample domain: ${configuredWebsite}`);
      const confirmed = (await ask('Have you confirmed that this is the company official site? Type yes to use it: ')).trim().toLocaleLowerCase('en');
      if (confirmed !== 'yes') {
        suppliedWebsite = (await ask('Enter the confirmed official website: ')).trim();
      } else {
        suppliedWebsite = configuredWebsite;
      }
    }
    const website = suppliedWebsite ? normalizeWebsite(suppliedWebsite) : '';
    if (!website) {
      throw new Error('No domain is configured for this company. Enter its confirmed official website or add a verified mapping to research/company_domains.json.');
    }

    let result;
    if (isDatabaseConfigured()) {
      const company = await findOrCreateCompany(companyName, website);
      const run = await createRun(company.id);
      run.companyName = company.company_name;
      console.log(`\nSaved research run ${run.id}; starting crawl of ${website}.`);
      result = await executeResearchRun(run, (event) => {
        if (event.step === 'crawling' && event.pages_visited % 5 === 0) {
          console.log(`Visited ${event.pages_visited} pages...`);
        }
      });
      console.log(`Research results saved to database (status: ${result.status}).`);
    } else {
      console.log('\nMySQL is not configured; this run will not be saved.');
      result = await runResearch(companyName, website, {
        onProgress(event) {
          if (event.step === 'crawling' && event.pages_visited % 5 === 0) {
            console.log(`Visited ${event.pages_visited} pages...`);
          }
        },
      });
    }
    console.log(`\nOutcome: ${result.status}`);
    console.log(`Pages visited: ${result.pages_visited}`);
    console.log(`Documents discovered: ${result.documents_discovered}`);
    console.log(`Documents processed: ${result.documents_processed}`);
    console.log(`Findings awaiting human review: ${result.findings.length}`);
    for (const document of result.documents) {
      console.log(`- ${document.title} [${document.status}]: ${document.url}`);
    }
    for (const finding of result.findings) {
      const year = finding.financial_year ? ` (${finding.financial_year})` : '';
      const page = finding.page_number ? `, page ${finding.page_number}` : '';
      console.log(`\n[${finding.field_name}]${year}: ${finding.value}`);
      console.log(`  Source: ${finding.source_url}${page}`);
      console.log(`  Evidence: ${finding.excerpt}`);
    }
    for (const error of result.errors) console.log(`Warning: ${error}`);
    for (const warning of result.warnings) console.log(`Note: ${warning}`);
    if (!result.documents.length) {
      console.log('No relevant documents were found. Confirm the domain or increase the configured crawl limits.');
    }
    console.log('Extracted findings are suggestions only; verify each source before use.');
  } finally {
    terminal.close();
  }
}

main().catch((error) => {
  console.error(`\nResearch could not be completed: ${error.message}`);
  process.exitCode = 1;
});
