'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSearch, interpretQuery } = require('../companySearch');
const { focusAreaKey, splitFocusAreas } = require('../companyFocusAreas');

test('natural language resolves supported location, industry, focus, and turnover phrases', () => {
  assert.deepEqual(interpretQuery('Find IT companies in Pune'), {
    q: '', filters: { city: 'Pune', industry: 'IT' },
  });
  assert.deepEqual(interpretQuery('Manufacturing companies focused on education'), {
    q: '', filters: { focus: 'education', industry: 'manufacturing' },
  });
  assert.deepEqual(interpretQuery('Companies with turnover above 500 crore'), {
    q: '', filters: { min_turnover: 500, turnover_unit: 'crore', turnover_currency: 'INR' },
  });
});

test('search SQL uses placeholders and validates sort, numbers, and ranges', () => {
  const result = buildSearch({ q: "x%' OR 1=1 --", sort: 'name', direction: 'desc', page: '2', limit: '20' });
  assert.match(result.where, /company_name LIKE \?/);
  assert.ok(result.params.every((value) => value.includes("x%' OR 1=1 --")));
  assert.equal(result.page, 2);
  assert.equal(result.limit, 20);
  assert.throws(() => buildSearch({ sort: 'company_name; DROP TABLE companies' }), /sort/);
  assert.throws(() => buildSearch({ sort: 'priority' }), /sort/);
  const keywordSearch = buildSearch({ q: 'high priority' });
  assert.doesNotMatch(keywordSearch.where, /c\.priority/);
  assert.throws(() => buildSearch({ turnover_operator: 'gte', turnover_amount: '-1', turnover_currency: 'INR', turnover_unit: 'crore' }), /non-negative/);
  assert.throws(() => buildSearch({ turnover_operator: 'between', turnover_amount: '100', turnover_amount_to: '10', turnover_currency: 'INR', turnover_unit: 'crore' }), /cannot exceed/);
});

test('combined filters apply as AND and focus uses a duplicate-safe EXISTS clause', () => {
  const result = buildSearch({ industry: 'Manufacturing', city: 'Pune', focus: 'Education', contact: 'present' });
  assert.match(result.where, / AND /);
  assert.match(result.where, /EXISTS \(SELECT 1 FROM company_focus_areas/);
  assert.match(result.where, /contact_name IS NOT NULL/);
});

test('Indian location and empty/all selections do not silently drop imported matches', () => {
  const pune = buildSearch({ city: 'Pune, India', industry: '', phase: 'all', focus: 'any' });
  assert.match(pune.where, /c\.city LIKE \?/);
  assert.match(pune.where, /location_source\.source_column IN \('City', 'Area', 'HQ'\)/);
  assert.ok(pune.params.includes('%Pune, India%'));
  const cleared = buildSearch({ city: '', industry: 'all', focus: 'any', phase: 'all' });
  assert.equal(cleared.where, '');
  assert.deepEqual(cleared.params, []);
});

test('turnover operators use the selected source basis and ignore incomplete conditions', () => {
  for (const [operator, sql] of [['gt', '> ?'], ['gte', '>= ?'], ['lt', '< ?'], ['lte', '<= ?']]) {
    const result = buildSearch({ turnover_operator: operator, turnover_amount: '25.5', turnover_currency: 'INR', turnover_unit: 'crore' });
    assert.ok(result.where.includes(`c.turnover_amount ${sql}`));
    assert.ok(result.params.includes(25.5));
  }
  const between = buildSearch({ turnover_operator: 'between', turnover_amount: '10', turnover_amount_to: '20', turnover_currency: 'INR', turnover_unit: 'crore' });
  assert.match(between.where, /turnover_amount >= \? AND c\.turnover_amount <= \?/);
  assert.deepEqual(between.params.slice(-4), ['crore', 'INR', 10, 20]);
  const empty = buildSearch({ turnover_operator: 'gte', turnover_amount: '', turnover_currency: 'INR', turnover_unit: 'crore' });
  assert.equal(empty.where, '');
  assert.throws(() => buildSearch({ turnover_operator: 'approximately', turnover_amount: '20' }), /turnover_operator/);
});

test('numbered focus lists split without splitting commas in theme names or keeping numbering', () => {
  const areas = splitFocusAreas(
    '1. Disability Empowerment (ARISE, SMART) 2. Technical & Vocational Education 3. School Quality Improvement',
    '1. Samsung Innovation Campus (Tech Skilling: AI, IoT, Coding)\n2. Solve for Tomorrow',
    '1. EDUCATION 2. Technical & Vocational Education',
  );
  assert.deepEqual(areas, [
    'Disability Empowerment (ARISE, SMART)',
    'Technical & Vocational Education',
    'School Quality Improvement',
    'Samsung Innovation Campus (Tech Skilling: AI, IoT, Coding)',
    'Solve for Tomorrow',
    'EDUCATION',
  ]);
  assert.equal(focusAreaKey(' 2. Technical & Vocational Education '), focusAreaKey('Technical & Vocational Education'));
  assert.deepEqual(splitFocusAreas('', '  ', null), []);
});

test('multiple focus filters use any or all semantics and preserve AND with other filters', () => {
  const any = buildSearch({ focus: ['Education & Digital Skilling', 'Environmental Sustainability'], city: 'Chennai' });
  assert.match(any.where, / AND /);
  assert.match(any.where, /EXISTS[\s\S]* OR EXISTS/);
  assert.ok(any.params.includes('education digital skilling'));
  assert.match(any.where, /normalized_focus_area = \?/);
  const all = buildSearch({ focus: ['Education & Digital Skilling', 'Environmental Sustainability'], focus_mode: 'all' });
  assert.match(all.where, /EXISTS[\s\S]* AND EXISTS/);
  assert.throws(() => buildSearch({ focus: ['Education'], focus_mode: 'none' }), /focus_mode/);
});

test('website_status correctly filters ready_to_research, needs_manual_review, and waiting_for_website', () => {
  const ready = buildSearch({ website_status: 'ready_to_research' });
  assert.match(ready.where, /c\.official_website IS NOT NULL AND c\.official_website != "" AND c\.official_website_verified_at IS NOT NULL/);

  const review = buildSearch({ website_status: 'needs_manual_review' });
  assert.match(review.where, /c\.website_candidate IS NOT NULL.*OR.*c\.notes LIKE "%MANUAL_REVIEW%"/);

  const waiting = buildSearch({ website_status: 'waiting_for_website' });
  assert.match(waiting.where, /c\.official_website IS NULL.*AND.*c\.website_candidate IS NULL/);
});
