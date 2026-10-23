'use strict';

const { focusAreaKey } = require('./companyFocusAreas');

const SORTS = Object.freeze({
  name: 'company_name', turnover: 'turnover_amount', industry: 'industry', city: 'city',
});
const scalar = (value, label, max = 160) => {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) throw Object.assign(new Error(`${label} is invalid.`), { status: 400 });
  return value.trim();
};
function amount(value, label) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1e15) throw Object.assign(new Error(`${label} must be a non-negative number.`), { status: 400 });
  return number;
}
const values = (value, label, max = 160) => {
  if (value == null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 20) throw Object.assign(new Error(`${label} supports at most 20 values.`), { status: 400 });
  return list.map((item) => scalar(item, label, max))
    .filter((item) => item && !['all', 'any'].includes(item.toLowerCase()));
};
function interpretQuery(input) {
  let q = String(input || '').trim().replace(/\s+/g, ' ').replace(/^(?:find|show|list)\s+/i, '');
  q = q.replace(/^companies?\s+(?:with|working in|focused on)\b\s+/i, '');
  const filters = {};
  const patterns = [
    [/\b(?:in|located in)\s+([\p{L}][\p{L} .'-]{1,50}?)(?=\s+(?:with|focused|having|above|below|over|under|and)\b|$)/iu, 'city'],
    [/\b(?:it|information technology) companies\b/iu, 'it'],
    [/\b(?:manufacturing) companies\b/iu, 'manufacturing'],
    [/\b(?:focused on|focus(?:ed)? area(?:s)?\s+(?:of|is))\s+([\p{L}][\p{L} .'-]{1,50}?)(?=\s+(?:with|in|and)\b|$)/iu, 'focus'],
    [/\b(?:turnover)\s+(?:above|over|more than)\s+([\d,.]+)\s*(crore|cr|lakh|million|billion)?/iu, 'turnover'],
    [/\b(?:without|missing)\s+(?:a\s+)?csr email\b/iu, 'no_email'],
    [/\b(?:with|having)\s+(?:a\s+)?csr (?:email|contact|contact person)\b/iu, 'has_contact'],
  ];
  for (const [pattern, kind] of patterns) {
    const match = q.match(pattern);
    if (!match) continue;
    if (kind === 'city') filters.city = match[1].trim();
    if (kind === 'focus') filters.focus = match[1].trim();
    if (kind === 'it') filters.industry = 'IT';
    if (kind === 'manufacturing') filters.industry = 'manufacturing';
    if (kind === 'turnover') { filters.min_turnover = Number(match[1].replaceAll(',', '')); filters.turnover_unit = (match[2] || '').toLowerCase().replace(/s$/, ''); filters.turnover_currency = /INR|Rs\.?|₹/i.test(match[0]) ? 'INR' : 'INR'; }
    if (kind === 'no_email') filters.contact = 'missing_email';
    if (kind === 'has_contact') filters.contact = 'present';
    q = q.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
  }
  if (/^(?:(?:show|list) )?(?:all )?companies[.!]?$/i.test(q)) q = '';
  return { q, filters };
}
function buildSearch(query) {
  let q = scalar(query.q, 'q', 200);
  let interpreted = { filters: {} };
  if (q) { interpreted = interpretQuery(q); q = interpreted.q; }
  const clauses = [];
  const params = [];
  const add = (condition, ...values) => { clauses.push(condition); params.push(...values); };
  if (q) {
    const like = `%${q}%`;
    add(`(c.company_name LIKE ? OR c.industry LIKE ? OR c.city LIKE ? OR c.region LIKE ? OR c.headquarters LIKE ? OR c.contact_name LIKE ? OR c.contact_designation LIKE ? OR c.contact_email LIKE ? OR EXISTS (SELECT 1 FROM company_aliases a WHERE a.company_id=c.id AND a.alias LIKE ?) OR EXISTS (SELECT 1 FROM company_focus_areas f WHERE f.company_id=c.id AND f.focus_area LIKE ?) OR EXISTS (SELECT 1 FROM company_source_values s WHERE s.company_id=c.id AND s.original_value LIKE ?))`, ...Array(11).fill(like));
  }
  const industries = values(query.industry || interpreted.filters.industry, 'industry');
  const cities = values(query.city || interpreted.filters.city, 'city');
  const regionValue = scalar(query.region, 'region');
  const region = ['all', 'any'].includes(regionValue.toLowerCase()) ? '' : regionValue;
  const requestedFocuses = values(query.focus, 'focus');
  const focuses = requestedFocuses.length ? requestedFocuses : values(interpreted.filters.focus, 'focus');
  if (industries.length) {
    const industryClauses = industries.map((value) => {
      if (value.toLowerCase() === 'it') return "LOWER(c.industry) REGEXP '(^|[^a-z])it([^a-z]|$)|information technology'";
      params.push(`%${value}%`);
      return 'c.industry LIKE ?';
    });
    clauses.push(`(${industryClauses.join(' OR ')})`);
  }
  if (cities.length) {
    clauses.push(`(${cities.map(() => `(c.city LIKE ? OR c.headquarters LIKE ? OR EXISTS (
      SELECT 1 FROM company_source_values location_source
      WHERE location_source.company_id = c.id
        AND location_source.source_column IN ('City', 'Area', 'HQ')
        AND location_source.original_value LIKE ?))`).join(' OR ')})`);
    params.push(...cities.flatMap((value) => [`%${value}%`, `%${value}%`, `%${value}%`]));
  }
  if (region) add('c.region LIKE ?', `%${region}%`);
  if (focuses.length) {
    const mode = String(query.focus_mode || 'any').toLowerCase();
    if (!['any', 'all'].includes(mode)) throw Object.assign(new Error('focus_mode must be any or all.'), { status: 400 });
    const exact = requestedFocuses.length > 0;
    const joins = focuses.map(() => `EXISTS (SELECT 1 FROM company_focus_areas f
      WHERE f.company_id=c.id AND f.normalized_focus_area ${exact ? '= ?' : 'LIKE ?'})`);
    clauses.push(`(${joins.join(mode === 'all' ? ' AND ' : ' OR ')})`);
    params.push(...focuses.map((value) => {
      const key = focusAreaKey(value);
      return exact ? key : `%${key}%`;
    }));
  }
  const operator = scalar(query.turnover_operator, 'turnover_operator', 12).toLowerCase();
  if (operator && !['gt', 'gte', 'lt', 'lte', 'between'].includes(operator)) throw Object.assign(new Error('turnover_operator must be gt, gte, lt, lte, or between.'), { status: 400 });
  const firstAmount = amount(query.turnover_amount ?? interpreted.filters.turnover_amount ?? interpreted.filters.min_turnover, 'turnover_amount');
  const secondAmount = amount(query.turnover_amount_to, 'turnover_amount_to');
  const effectiveOperator = operator || interpreted.filters.turnover_operator || (interpreted.filters.min_turnover != null ? 'gte' : '');
  const hasTurnoverCondition = Boolean(effectiveOperator && firstAmount != null && (effectiveOperator !== 'between' || secondAmount != null));
  if (effectiveOperator === 'between' && firstAmount != null && secondAmount != null && firstAmount > secondAmount) throw Object.assign(new Error('turnover_amount cannot exceed turnover_amount_to.'), { status: 400 });
  const sortRequested = query.sort || 'name';
  if (hasTurnoverCondition || sortRequested === 'turnover') {
    const unit = scalar(query.turnover_unit || interpreted.filters.turnover_unit, 'turnover_unit', 40);
    const currency = scalar(query.turnover_currency || interpreted.filters.turnover_currency, 'turnover_currency', 12);
    if (!unit || !currency) throw Object.assign(new Error('Choose a turnover currency and unit before comparing amounts.'), { status: 400 });
    if (!/^[A-Za-z]{3}$/.test(currency)) throw Object.assign(new Error('turnover_currency must be a three-letter currency code.'), { status: 400 });
    const normalizedUnit = unit.toLowerCase().replace(/s$/, '').replace(/^cr$/, 'crore').replace(/^mn$/, 'million');
    add(`CASE LOWER(TRIM(TRAILING "s" FROM COALESCE(c.turnover_unit,
      CASE WHEN LOWER(COALESCE(c.turnover_original, "")) REGEXP 'crore|\\bcr\\b' THEN 'crore'
           WHEN LOWER(COALESCE(c.turnover_original, "")) REGEXP 'lakh' THEN 'lakh'
           WHEN LOWER(COALESCE(c.turnover_original, "")) REGEXP 'million|\\bmn\\b' THEN 'million'
           WHEN LOWER(COALESCE(c.turnover_original, "")) REGEXP 'billion' THEN 'billion' ELSE "" END, "")))
      WHEN 'cr' THEN 'crore' WHEN 'mn' THEN 'million' WHEN 'crore' THEN 'crore'
      WHEN 'lakh' THEN 'lakh' WHEN 'million' THEN 'million' WHEN 'billion' THEN 'billion'
      ELSE LOWER(TRIM(TRAILING "s" FROM COALESCE(c.turnover_unit, ""))) END = ?`, normalizedUnit);
    add(`COALESCE(c.turnover_currency,
      CASE WHEN UPPER(COALESCE(c.turnover_original, "")) LIKE '%INR%'
             OR UPPER(COALESCE(c.turnover_original, "")) LIKE '%RS%'
             OR COALESCE(c.turnover_original, "") LIKE '%₹%' THEN 'INR' ELSE NULL END) = ?`, currency.toUpperCase());
    if (hasTurnoverCondition) {
      const comparison = { gt: '>', gte: '>=', lt: '<', lte: '<=', between: null }[effectiveOperator];
      if (effectiveOperator === 'between') add('c.turnover_amount >= ? AND c.turnover_amount <= ?', firstAmount, secondAmount);
      else add(`c.turnover_amount ${comparison} ?`, firstAmount);
    }
  }
  if (query.turnover_missing === 'true') clauses.push('c.turnover_amount IS NULL');
  if (query.turnover_missing === 'false') clauses.push('c.turnover_amount IS NOT NULL');
  const contact = scalar(query.contact || interpreted.filters.contact, 'contact', 30);
  if (contact === 'present') clauses.push('(c.contact_name IS NOT NULL OR c.contact_email IS NOT NULL)');
  if (contact === 'missing_email') clauses.push('(c.contact_email IS NULL OR c.contact_email = "")');
  if (query.missing_industry === 'true') clauses.push('(c.industry IS NULL OR c.industry = "")');
  if (query.missing_location === 'true') clauses.push('((c.city IS NULL OR c.city = "") AND (c.headquarters IS NULL OR c.headquarters = ""))');
  if (query.missing_focus === 'true') clauses.push('NOT EXISTS (SELECT 1 FROM company_focus_areas f WHERE f.company_id=c.id)');
  if (query.missing_contact === 'true') clauses.push('(c.contact_name IS NULL OR c.contact_name = "")');
  const websiteStatus = scalar(query.website_status, 'website_status', 40);
  if (websiteStatus === 'ready_to_research') {
    clauses.push('(c.official_website IS NOT NULL AND c.official_website != "" AND c.official_website_verified_at IS NOT NULL)');
  } else if (websiteStatus === 'needs_manual_review') {
    clauses.push('((c.official_website IS NULL OR c.official_website = "" OR c.official_website_verified_at IS NULL) AND ((c.website_candidate IS NOT NULL AND c.website_candidate != "") OR (c.notes LIKE "%MANUAL_REVIEW%")))');
  } else if (websiteStatus === 'waiting_for_website') {
    clauses.push('((c.official_website IS NULL OR c.official_website = "") AND (c.website_candidate IS NULL OR c.website_candidate = "") AND (c.notes NOT LIKE "%MANUAL_REVIEW%" OR c.notes IS NULL))');
  }
  const sort = SORTS[sortRequested];
  if (!sort) throw Object.assign(new Error('sort must be name, turnover, industry, or city.'), { status: 400 });
  const direction = String(query.direction || 'asc').toLowerCase();
  if (!['asc', 'desc'].includes(direction)) throw Object.assign(new Error('direction must be asc or desc.'), { status: 400 });
  const page = Number(query.page || 1);
  const limit = Number(query.limit || 50);
  if (!Number.isInteger(page) || page < 1 || page > 100000) throw Object.assign(new Error('page must be a positive whole number.'), { status: 400 });
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('limit must be between 1 and 100.'), { status: 400 });
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params, sort, direction, page, limit, interpreted };
}
module.exports = { buildSearch, interpretQuery };
