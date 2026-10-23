# CSR research data field mapping

## Scope and audit result

This mapping traces the current React forms, Express API payloads, MySQL schema,
and Python research output. The Hinjewadi, Delhi NCR, and Chennai workbooks
were present in the workspace and scanned through the import parser. The
worksheet names and headers below are the values read from those files; imports
remain preview-only unless the researcher explicitly confirms them.

## Existing frontend and API fields

| Collected or displayed field | Frontend/API contract | Database storage |
|---|---|---|
| Company name | `company_name` in create/edit forms; `companyName` in research request | `companies.company_name`, normalized into `companies.normalized_name` |
| Industry | `industry` in create/edit forms and profile | `companies.industry` |
| Official website | `official_website`, explicit confirmation boolean before save/research | `companies.official_website`; confirmation timestamp is `official_website_verified_at`; each run snapshots it in `research_runs.confirmed_domain` |
| Researcher notes | `notes` | `companies.notes` |
| Company aliases | Not collected by the current form | `company_aliases.alias`, `normalized_alias` (new; one canonical company FK) |
| CIN | `cin` in the updated create/edit forms | `companies.cin` (new; indexed, not unique so imported conflicts remain resolvable) |
| City/headquarters | `city` in the updated create/edit forms | `companies.city` (new) |
| Contact name/designation/email/phone | `contact_name`, `contact_designation`, `contact_email`, `contact_phone` in company create/edit/profile | `companies.contact_name`, `companies.contact_designation`, `companies.contact_email`, `companies.contact_phone` |
| Candidate website from imports | Not collected by the current form; never treated as verified | `companies.website_candidate` (new), kept separate from `official_website` |
| Research priority | `priority` in the updated create/edit forms | `companies.priority` (new; researcher metadata) |
| Run status, progress, pages/documents/findings counts, errors/warnings | Dashboard, history, detail views and `/api/research` contracts | `research_runs` existing columns; `confirmed_domain` and `summary` are added |
| Document title, URL, file type, status, processing error and extracted text | Profile, run report, document modal | `documents` existing columns; `document_type`, `financial_year`, and `publication_date` are added when present |
| Finding field/value/original value, financial year, URL, page, evidence excerpt, method, review status/notes | Profile review form and saved run report | `findings` existing columns; category, numeric amount, currency, unit, focus area, provenance, import row and reviewer identity are added |
| Finding decision/value/year/reviewer notes | `PATCH /api/findings/:id/review` | Current state remains in `findings`; every decision/value change is appended to `finding_review_history` |
| Unavailable field marker | Profile's manual “mark unavailable” action | Existing `findings` row with `review_status='unavailable'` and `extraction_method='manual'`; provenance is `researcher_supplied` |

## Supplied workbook columns

| Workbook | Worksheets and source columns |
|---|---|
| Hinjewadi CSR data.xlsx · `u are doing it wrong why are u ` | `Company`, `Phase`, `Industry`, `CSR Focus Areas`, `CSR Budget / Amount Spent`, `CSR Head / Contact Person`, `CSR Email Link`, `Priority Tier`, `HQ` |
| CSR_Delhi_NCR_Companies_50_Completed Work.xlsx · `CSR Companies` | `Company Name`, `City`, `Industry`, `Turnover`, `CSR Head`, `Designation`, `CSR Focus Areas`, `CSR Email Link`, `Priority Tier`, `Primary CSR Themes` |
| Akshar_Bharati_Chennai_CSR_Companies.xlsx · `Chennai CSR Companies` | `Company Name`, `Area`, `Industry`, `Turnover`, `CSR Head`, `Designation`, `Priority` |
| Akshar_Bharati_Chennai_CSR_Companies.xlsx · `Notes` | `Notes`, `Column 2` (blank source header) |

The importer proposes mappings from actual uploaded headers for company name,
aliases, CIN, industry, city, CSR contact name/designation/email, website candidate, priority,
financial year, source URL/title/document type/publication date, company turnover,
revenue and sales amounts, CSR obligation/expenditure/unspent amounts, focus areas, projects, implementation
partners, committees, policies and observations. Users can change every
proposal. Original cell values and source row are retained in
`import_batch_rows.original_data` and imported CSR values remain pending review.
If a spreadsheet has no source URL, its finding explicitly records that source
evidence was not provided; the importer does not invent one.
Headers containing turnover, revenue or sales are rejected if mapped to a CSR
expenditure field, preventing company revenue from being stored as CSR spend.
They can map to distinct `turnover_amount`, `revenue_amount`, and
`sales_amount` findings, with the same financial-year, source, and pending-review
provenance. The combined Hinjewadi `CSR Budget / Amount Spent` header remains
unmapped because it does not distinguish budget/obligation from realized
expenditure. Original row values and workbook row provenance remain preserved.

## Python research-engine contract

| Python output | Existing/new MySQL storage |
|---|---|
| Result `company_name`, `official_website`, `status`, pages visited, discovered/processed counts, errors, warnings, extraction status | Existing `companies` identity and `research_runs` status/counters/errors/warnings; run confirmed URL and summary are added |
| Document `url`, `title`, `file_type`, `status`, `content_hash`, `storage_name`, `text`, `error` | `documents.source_url`, `title`, `file_type`, `processing_status`, `content_hash`, `storage_name`, `extracted_text`, `processing_error` |
| Finding `field_name`, `value`, `financial_year`, `source_url`, `source_title`, `page_number`, `excerpt`, `extraction_method`, `review_status` | `findings.field_name`, `finding_value`, `original_value`, `financial_year`, `source_url`, `page_number`, `supporting_excerpt`, `extraction_method`, `review_status`; source document by `document_id`; provenance `extracted` |
| Amount text such as CSR budget/obligation/expenditure/unspent, turnover, revenue, or sales | Original amount remains exact in `finding_value`; parsed numeric amount/currency/unit are stored separately in `numeric_value`, `currency`, `unit`. Each amount type keeps its own `field_name`; turnover/revenue/sales never map to CSR expenditure |
| Annual report/BRSR/CSR policy source identity | Existing document URL/title/type plus new `documents.document_type`; a year/date is stored only if supplied by the extractor, otherwise left `NULL` |
| Research run's documents/findings | Existing `research_run_documents` and `research_run_findings` relationships |
| Human review changes | New append-only `finding_review_history`, FK to finding with prior/revised values, financial years, decision, reviewer, reason and timestamp |

## Database and workflow changes

## Research quality audit and current local findings

The connected MySQL registry contained 124 companies. Five historical research
runs existed across Tata Motors and Wipro, with the latest run on each company
partially completed. Tata Motors run 9 contained 281 saved findings: 149 were
`csr_observation`, 86 `csr_project`, 28 `csr_committee`, 16 implementation
partners, and 2 CSR expenditure amounts. Findings linked to company 11 and a
document/source URL, but several observations included marketing copy or joined
navigation and footer text; those rows had no structured monetary values or
financial years. For example, a stored observation described “positive social
impact” from a community webpage, and another combined website navigation with
sustainability copy. Existing saved findings were not rewritten.

New extraction removes navigation, headers, footers, scripts, sidebars, and
forms from HTML text before relevance scoring and extraction. The keyword
extractor no longer emits a generic `csr_observation` for broad mentions. It
retains specific fields for committee, focus area, project, implementation
partner, policy reference, and CSR budget. Monetary extraction classifies CSR
budget, obligation, realized expenditure, and unspent amounts independently;
turnover/revenue/sales use separate amount fields and are never classified as
CSR expenditure. Ambiguous sentences mixing company revenue and CSR amounts
are left unclassified. Each amount
retains its original string, while the numeric value, currency, and unit are
parsed only where possible. Missing year, amount, unit, or evidence stays NULL
or unverified.

The registry API now supports batch initiation for up to 25 selected companies.
The in-process scheduler limits active crawls to two and waits one second
between starts. Each company receives its own persistent run, so failures are
isolated and visible. A company must already have a confirmed official domain;
candidate imported websites are not treated as verified. Retrying creates a
new run while the existing evidence hash and company/source keys prevent
uncontrolled duplicate finding rows. These controls do not constitute a
durable external job queue; queued work interrupted by an API restart follows
the existing recovery behavior and is marked failed.

## Web-checked domain suggestions

Official investor/CSR pages were checked for eleven records with no saved
domain: Apollo Hospitals, BSES Rajdhani Power, Dabur India, DLF, Fortis
Healthcare, BEL Delhi, Tata Power-DDL, Power Grid, RITES, Engineers India,
and Relaxo Footwears. Their domain candidates and the
primary company source page are recorded in `research/company_domains.json`.
The edit form exposes the source link and verification note. Suggestions never
write to `companies.official_website`; the researcher must select the candidate
and explicitly confirm it. Apollo Hospitals and BEL Delhi retain a note to
verify that the group/company domain matches the exact local registry entity.

The existing `companies`, `research_runs`, `documents`, and `findings` tables
remain canonical. Migration `003_import_provenance.sql` adds their missing
metadata and creates only the supporting alias, import batch/row and review
history tables. Imported source URLs can create a document with no research run
yet; `documents.research_run_id` is nullable for this case, while the document
retains its import-row provenance. Existing confirmed domains and research
records are preserved.
Import scans and previews do not write; confirmation uses a transaction,
upserts missing values only, preserves confirmed domains, and links imported
findings back to batch rows. Imported or extracted findings are never approved
automatically.
When a reviewer edits an amount finding, its structured numeric value, currency
and unit are recalculated from the edited text; an unparseable edit clears the
structured amount instead of retaining stale data or substituting zero.

## Company discovery rebuild (2026-10-21)

The current schema was audited before additions. `companies` remains the
canonical company identity table; `company_aliases` retains its existing
normalized alias uniqueness; import batches/rows retain their existing generic
provenance; `research_runs`, `documents`, and `findings` remain intact.
Migration `009_company_discovery.sql` is additive. It adds phase, region,
headquarters, numeric turnover plus currency/unit/original text, normalized
focus areas, and per-cell workbook provenance. It does not drop or rewrite
existing research data. `database/schema.sql` contains the same additions for
new installations.

| Workbook / worksheet | Source columns | Canonical storage |
|---|---|---|
| `Hinjewadi CSR data.xlsx` / `u are doing it wrong why are u ` | `Company`, `Phase`, `Industry`, `CSR Focus Areas`, `CSR Budget / Amount Spent`, `CSR Head / Contact Person`, `CSR Email Link`, `Priority Tier`, `HQ` | Company name; phase; industry; focus areas; CSR contact name/email; priority; HQ. City is populated from HQ only when the value explicitly identifies India. The combined CSR money label is retained exactly as a source cell because it does not distinguish budget from actual expenditure. |
| `CSR_Delhi_NCR_Companies_50_Completed Work.xlsx` / `CSR Companies` | `Company Name`, `City`, `Industry`, `Turnover`, `CSR Head`, `Designation`, `CSR Focus Areas`, `CSR Email Link`, `Priority Tier`, `Primary CSR Themes` | Name, city, industry, turnover numeric value and original/currency/unit when parseable, contact name/designation/email, priority, and individual focus values. |
| `Akshar_Bharati_Chennai_CSR_Companies.xlsx` / `Chennai CSR Companies` | `Company Name`, `Area`, `Industry`, `Turnover`, `CSR Head`, `Designation`, `Priority` | Name, city from area, industry, turnover with source text and parsed unit/currency when present, contact, and priority. |
| `Akshar_Bharati_Chennai_CSR_Companies.xlsx` / `Notes` | `Notes`, blank second header (represented as `Column 2`) | Inspected and excluded from company rows. |

Names match through the existing normalized-name unique key. Existing non-empty
canonical fields are not overwritten. Every non-empty source cell is upserted
by company/workbook/worksheet/row/column in `company_source_values`; focus areas
are individually searchable in `company_focus_areas`. The initial import had
163 companies (39 newly created from Chennai), 1,608 source-cell provenance
rows, 448 pre-normalization focus-area rows, and 74 companies with numeric
turnover. The later source-only reconciliation found 162 unique workbook names
and one out-of-scope company, Tata Motors. Exact normalized company names were
used because the source sheets contain no registration number or website
columns; all 162 source names matched, with no ambiguous match. Tata Technologies
is present in the Hinjewadi sheet and remains a separate exact-name record.
Tata Motors had no source-workbook row and was removed. Its two research runs,
35 documents, and 281 findings were removed by the inspected company foreign-key
cascades; retained companies' records remain. The database now contains 162
companies, 6 research runs, 121 documents, 242 findings, and 1,608 source-cell
rows. The focus rows were rebuilt from the verbatim workbook cells: enumerated
lists are split into separate areas, numeric list prefixes are removed from
display labels, punctuation/case-normalized keys deduplicate repeated themes,
and source strings remain preserved in `company_source_values`. This yields
604 company-focus rows across 102 distinct readable focus options.
First-run per-workbook outcomes: Hinjewadi 85 rows / 76 unique / 0 created / 76
updated / 9 duplicate rows merged / 0 skipped / 0 errors; Delhi NCR 50 / 50 / 0
/ 50 / 0 / 0 / 0; Chennai 49 / 49 / 39 / 8 / 0 / 5 Notes rows skipped / 0.
The 5 Notes rows are worksheet notes rather than company data rows. An immediate
rerun created or updated no records and did not duplicate provenance/focus
rows. No import errors occurred.

Search uses parameterized server queries for company names, aliases, industry,
location, headquarters, CSR contact, and focus areas. Filter categories combine
with AND. The workbook's `Phase` values (I/II/III) are retained as source data
but are not exposed as a filter because their meaning is undefined. `Priority`
and `Priority Tier` values use mixed scales (`High`/`Medium`, `A`/`B`/`C`, and
named tiers), so source priority remains visible as raw metadata and is not a
filter. Turnover supports greater-than, inclusive greater-than, less-than,
inclusive less-than, and between comparisons against the selected stored unit
and currency; no conversion is performed. Focus uses `EXISTS` to avoid
duplicate results. Selecting multiple focus areas defaults to “any selected”;
users can switch to “all selected.” Explicit focus selections match normalized
area keys, while free-text focus queries can still match partial terms. Sort
fields are allowlisted and pagination is server-side.
The location picker uses the original `City` and `Area` cells from the Delhi NCR
and Chennai sheets plus `HQ` cells explicitly marked `India` in the Hinjewadi
sheet. This keeps locality strings such as Guindy and OMR intact while leaving
international HQ source values preserved in company provenance, outside the
Indian location suggestions. The profile's “Workbook values and provenance”
table displays every non-empty source header/value with workbook, worksheet,
and row, including fields without a safe canonical mapping. The list and typed
profile fields use canonical values for quick scanning.
None of the three company sheets has `District` or `State` headers. The
Hinjewadi `Phase` field contains I/II/III, not a city/district/state value.
The Chennai Notes sheet has `Notes` and an empty second header; those five
free-text note rows are not company records and were not mapped onto a company.
Turnover remains a separate canonical value and is never inferred from the
Hinjewadi `CSR Budget / Amount Spent` field.
Supported deterministic natural-language phrases include industry, city,
focus area, turnover-above thresholds, and contact/email presence. Other
wording falls back to regular text search; no AI service or generated SQL is
used.

Adding a company with a confirmed official website queues a report-discovery
run. Researchers can also start or retry a run from the company profile or run
history. Active queued/running runs are reused instead of duplicated. Discovery
records PDF candidates and validates downloads; it does not extract findings
or call Gemini. Run migration `010_verified_report_discovery.sql` before using
the new source-page and validation fields.
