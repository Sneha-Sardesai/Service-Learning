'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCompanyName, normalizeWebsite, validateCompanyName } = require('../validation');

test('company names are trimmed, normalized, and rejected when empty', () => {
  assert.equal(validateCompanyName('  Tata   Motors  '), 'Tata Motors');
  assert.equal(normalizeCompanyName('TÁTA Motors, Ltd.'), 'tata motors ltd');
  assert.throws(() => validateCompanyName('   '), /Company name/);
  assert.throws(() => validateCompanyName('!!!'), /letters or numbers/);
  assert.throws(() => validateCompanyName('x'.repeat(201)), /200 characters/);
});

test('website normalization accepts domains and rejects unsafe URL forms', () => {
  assert.equal(normalizeWebsite('Example.com/about#team'), 'https://example.com/about');
  assert.throws(() => normalizeWebsite('file:///etc/passwd'), /website URL/);
  assert.throws(() => normalizeWebsite('http://127.0.0.1'), /public http/);
  assert.throws(() => normalizeWebsite('http://localhost'), /public http/);
  assert.throws(() => normalizeWebsite('https://user:secret@example.com'), /public http/);
  assert.throws(() => normalizeWebsite('https://example.com:8443'), /public http/);
});
