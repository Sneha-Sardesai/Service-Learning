'use strict';

function parseMoney(value) {
  const text = String(value || '');
  const match = text.match(/(?:INR|Rs\.?|₹)?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(crores?|cr|lakhs?|million|billion|mn))?/i);
  if (!match) return { numeric: null, currency: null, unit: null };
  const numeric = match[1].replaceAll(',', '');
  if (!/^\d{1,16}(?:\.\d{1,4})?$/.test(numeric)) {
    return { numeric: null, currency: null, unit: null };
  }
  return {
    numeric,
    currency: /INR|Rs\.?|₹/i.test(text) ? 'INR' : null,
    unit: match[2] ? (match[2].toLowerCase() === 'mn' ? 'million' : match[2].toLowerCase()) : null,
  };
}

function reviewedMoneyFields(fieldName, value, current) {
  if (!/_amount$/.test(fieldName)) {
    return {
      numeric: current.numeric_value,
      currency: current.currency,
      unit: current.unit,
    };
  }
  return parseMoney(value);
}

module.exports = { parseMoney, reviewedMoneyFields };
