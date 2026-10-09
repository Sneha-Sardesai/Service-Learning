'use strict';

class ValidationError extends TypeError {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function normalizeCompanyName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function validateCompanyName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    throw new ValidationError('Company name must contain between 1 and 200 characters.');
  }
  const name = value.trim().replace(/\s+/g, ' ');
  if (!normalizeCompanyName(name)) {
    throw new ValidationError('Company name must contain letters or numbers.');
  }
  return name;
}

function normalizeWebsite(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('Official website is required.');
  }
  let candidate = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^https?:\/\//i.test(candidate)) {
    throw new ValidationError('Enter a valid official website URL.');
  }
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ValidationError('Enter a valid official website URL.');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !hostname
    || parsed.username
    || parsed.password
    || parsed.port && !['80', '443'].includes(parsed.port)
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname.includes(':')) {
    throw new ValidationError('Use a public http:// or https:// company domain without credentials or a custom port.');
  }
  parsed.hostname = hostname;
  parsed.hash = '';
  return parsed.toString();
}

module.exports = { normalizeCompanyName, normalizeWebsite, validateCompanyName, ValidationError };
