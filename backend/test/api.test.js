'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');
const { runResearch } = require('../researchService');

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
  context.after(() => {
    server.close();
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
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const badId = await fetch(`${base}/api/companies/nope`);
  assert.equal(badId.status, 400);
  assert.match((await badId.json()).error, /numeric ID/);
  const badCompany = await fetch(`${base}/api/companies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_name: '' }),
  });

  test('Node-to-Python bridge reports unknown domains without guessing', async () => {
    await assert.rejects(
      runResearch('Unknown Example Company'),
      /No confirmed official website/,
    );
  });
  assert.equal(badCompany.status, 400);
  assert.match((await badCompany.json()).error, /Company name/);
});
