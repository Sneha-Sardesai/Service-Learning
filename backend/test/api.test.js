'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');
const { runResearch } = require('../researchService');

function closeTestServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

test('API reports missing MySQL configuration without leaking internals', async (context) => {
  const original = {
    host: process.env.DB_HOST,
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };
  delete process.env.DB_HOST;
  delete process.env.DB_NAME;
  delete process.env.DB_USER;
  delete process.env.DB_PASSWORD;
  const server = app.listen(0);
  context.after(async () => {
    await closeTestServer(server);
    for (const [key, value] of Object.entries({
      DB_HOST: original.host,
      DB_NAME: original.name,
      DB_USER: original.user,
      DB_PASSWORD: original.password,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: 'degraded',
    database: 'not_configured',
    message: 'Copy .env.example to .env and configure MySQL before using the application.',
  });
});

test('API validates IDs and company payloads before database access', async (context) => {
  const server = app.listen(0);
  context.after(() => closeTestServer(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  const badId = await fetch(`${base}/api/companies/nope`);
  assert.equal(badId.status, 400);
  assert.match((await badId.json()).error, /numeric ID/);
  const badCompany = await fetch(`${base}/api/companies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_name: '' }),
  });
  assert.equal(badCompany.status, 400);
  assert.match((await badCompany.json()).error, /Company name/);
});

test('API rejects invalid research-history pagination and review states before database access', async (context) => {
  const server = app.listen(0);
  context.after(() => closeTestServer(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  const badPage = await fetch(`${base}/api/research?page=0`);
  assert.equal(badPage.status, 400);
  assert.match((await badPage.json()).error, /page/);
  const badReview = await fetch(`${base}/api/findings/1/review`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ review_status: 'verified' }),
  });
  assert.equal(badReview.status, 400);
  assert.match((await badReview.json()).error, /review_status/);
});

test('API requires explicit official-domain confirmation before saving or researching', async (context) => {
  const server = app.listen(0);
  context.after(() => closeTestServer(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  const company = await fetch(`${base}/api/companies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company_name: 'Confirmation Test Company',
      official_website: 'https://company.example',
    }),
  });
  assert.equal(company.status, 400);
  assert.match((await company.json()).error, /Confirm/);
  const research = await fetch(`${base}/api/companies/1/research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(research.status, 400);
  assert.match((await research.json()).error, /Confirm/);
});

test('API returns an unconfirmed empty result for an unknown sample-domain match', async (context) => {
  const server = app.listen(0);
  context.after(() => closeTestServer(server));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/company-domain-suggestions?company_name=Unknown%20Research%20Company`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    suggested_website: null,
    requires_confirmation: false,
  });
});

test('API scans CSV headers and returns mappings before any import confirmation', async (context) => {
  const server = app.listen(0);
  context.after(() => closeTestServer(server));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/imports/scan?filename=companies.csv`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('Company Name,Industry\nExample Ltd,Technology\n'),
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.headers[0], 'Company Name');
  assert.equal(result.suggested_mappings['Company Name'], 'company_name');
  assert.equal(result.sample_rows[0]['Company Name'], 'Example Ltd');
});

test('API prevents turnover columns from being mapped to CSR expenditure', async (context) => {
  const server = app.listen(0);
  context.after(() => closeTestServer(server));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/imports/preview?filename=financials.csv`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Import-Mappings': JSON.stringify({
          Company: 'company_name',
          Turnover: 'csr_expenditure_amount',
        }),
      },
      body: Buffer.from('Company,Turnover\nExample Ltd,1000000\n'),
    },
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Turnover, revenue, and sales/);
});

test('API normalizes newline-separated contact emails without losing source values', async (context) => {
  const server = app.listen(0);
  context.after(() => closeTestServer(server));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/imports/preview?filename=contacts.csv`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Import-Mappings': JSON.stringify({
          Company: 'company_name',
          'CSR Email Link': 'contact_email',
        }),
      },
      body: Buffer.from('Company,CSR Email Link\nExample Ltd,"first@example.test\nsecond@example.test"\n'),
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.error_rows, 0);
  assert.equal(result.rows[0].mapped.contact_email, 'first@example.test; second@example.test');
  assert.equal(result.rows[0].original['CSR Email Link'], 'first@example.test\nsecond@example.test');
});

test('Node-to-Python bridge reports unknown domains without guessing', async () => {
  await assert.rejects(
    runResearch('Unknown Example Company'),
    /No confirmed official website/,
  );
});
