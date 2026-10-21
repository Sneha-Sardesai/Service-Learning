'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewedMoneyFields } = require('../money');

test('reviewing a CSR amount refreshes the structured monetary value', () => {
  assert.deepEqual(
    reviewedMoneyFields('csr_expenditure_amount', 'INR 2.50 crore', {
      numeric_value: '1.2500',
      currency: 'INR',
      unit: 'crore',
    }),
    { numeric: '2.50', currency: 'INR', unit: 'crore' },
  );
});

test('reviewing a CSR amount without a parseable value clears stale structured data', () => {
  assert.deepEqual(
    reviewedMoneyFields('csr_expenditure_amount', 'not stated', {
      numeric_value: '1.2500',
      currency: 'INR',
      unit: 'crore',
    }),
    { numeric: null, currency: null, unit: null },
  );
});

test('reviewing a non-monetary finding preserves any structured fields', () => {
  assert.deepEqual(
    reviewedMoneyFields('csr_focus_area', 'Education', {
      numeric_value: '1.2500',
      currency: 'INR',
      unit: 'crore',
    }),
    { numeric: '1.2500', currency: 'INR', unit: 'crore' },
  );
});
