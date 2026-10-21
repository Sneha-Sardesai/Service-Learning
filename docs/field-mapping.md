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
financial year, source URL/title/document type/publication date, CSR
obligation/expenditure/unspent amounts, focus areas, projects, implementation
partners, committees, policies and observations. Users can change every
proposal. Original cell values and source row are retained in
`import_batch_rows.original_data` and imported CSR values remain pending review.
If a spreadsheet has no source URL, its finding explicitly records that source
evidence was not provided; the importer does not invent one.
Headers containing turnover, revenue or sales are rejected if mapped to a CSR
expenditure field, preventing company revenue from being stored as CSR spend.
The combined Hinjewadi `CSR Budget / Amount Spent` header remains unmapped
because it does not distinguish budget/obligation from realized expenditure.
`Turnover` remains unmapped and cannot be mapped to a CSR amount. Original row
values remain available for other researcher-selected mappings.

## Python research-engine contract

| Python output | Existing/new MySQL storage |
|---|---|
| Result `company_name`, `official_website`, `status`, pages visited, discovered/processed counts, errors, warnings, extraction status | Existing `companies` identity and `research_runs` status/counters/errors/warnings; run confirmed URL and summary are added |
| Document `url`, `title`, `file_type`, `status`, `content_hash`, `storage_name`, `text`, `error` | `documents.source_url`, `title`, `file_type`, `processing_status`, `content_hash`, `storage_name`, `extracted_text`, `processing_error` |
| Finding `field_name`, `value`, `financial_year`, `source_url`, `source_title`, `page_number`, `excerpt`, `extraction_method`, `review_status` | `findings.field_name`, `finding_value`, `original_value`, `financial_year`, `source_url`, `page_number`, `supporting_excerpt`, `extraction_method`, `review_status`; source document by `document_id`; provenance `extracted` |
| Amount text such as CSR obligation/expenditure/unspent amount | Original amount remains exact in `finding_value`; parsed numeric amount/currency/unit are stored separately in `numeric_value`, `currency`, `unit`. Turnover is not mapped into these CSR fields |
| Annual report/BRSR/CSR policy source identity | Existing document URL/title/type plus new `documents.document_type`; a year/date is stored only if supplied by the extractor, otherwise left `NULL` |
| Research run's documents/findings | Existing `research_run_documents` and `research_run_findings` relationships |
| Human review changes | New append-only `finding_review_history`, FK to finding with prior/revised values, financial years, decision, reviewer, reason and timestamp |

## Database and workflow changes

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
