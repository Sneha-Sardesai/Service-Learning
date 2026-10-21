USE csr_research;

-- Extend the existing canonical registry and research tables without replacing
-- existing data or confirmed domains. Apply once after migration 002.
ALTER TABLE companies
  ADD COLUMN cin VARCHAR(21) NULL AFTER normalized_name,
  ADD COLUMN city VARCHAR(160) NULL AFTER industry,
  ADD COLUMN website_candidate VARCHAR(2048) NULL AFTER official_website,
  ADD COLUMN official_website_verified_at DATETIME NULL AFTER website_candidate,
  ADD COLUMN contact_email VARCHAR(254) NULL AFTER official_website_verified_at,
  ADD COLUMN contact_phone VARCHAR(40) NULL AFTER contact_email,
  ADD COLUMN priority VARCHAR(80) NULL AFTER contact_phone,
  ADD COLUMN data_origin ENUM('researcher_created', 'manual_import') NOT NULL DEFAULT 'researcher_created' AFTER priority,
  ADD KEY idx_companies_cin (cin),
  ADD KEY idx_companies_city (city);

CREATE TABLE company_aliases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  alias VARCHAR(200) NOT NULL,
  normalized_alias VARCHAR(200) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_alias_normalized (normalized_alias),
  KEY idx_company_alias_company (company_id),
  CONSTRAINT fk_company_alias_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE import_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uploaded_filename VARCHAR(255) NOT NULL,
  worksheet_name VARCHAR(255) NULL,
  status ENUM('completed', 'completed_with_errors', 'failed') NOT NULL DEFAULT 'completed',
  field_mappings JSON NOT NULL,
  imported_rows INT UNSIGNED NOT NULL DEFAULT 0,
  error_rows INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_import_batches_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE import_batch_rows (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  import_batch_id BIGINT UNSIGNED NOT NULL,
  `row_number` INT UNSIGNED NOT NULL,
  original_data JSON NOT NULL,
  mapped_data JSON NOT NULL,
  validation_errors JSON NOT NULL,
  outcome ENUM('created', 'merged', 'skipped', 'invalid', 'duplicate_in_upload') NOT NULL,
  company_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_import_batch_row (import_batch_id, `row_number`),
  KEY idx_import_rows_company (company_id),
  KEY idx_import_rows_outcome (import_batch_id, outcome),
  CONSTRAINT fk_import_rows_batch FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  CONSTRAINT fk_import_rows_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
) ENGINE=InnoDB;

ALTER TABLE research_runs
  ADD COLUMN confirmed_domain VARCHAR(2048) NULL AFTER warning_summary,
  ADD COLUMN summary TEXT NULL AFTER confirmed_domain;

ALTER TABLE documents DROP FOREIGN KEY fk_documents_run;

ALTER TABLE documents
  MODIFY COLUMN research_run_id BIGINT UNSIGNED NULL,
  ADD COLUMN document_type VARCHAR(80) NULL AFTER file_type,
  ADD COLUMN financial_year VARCHAR(20) NULL AFTER document_type,
  ADD COLUMN publication_date DATE NULL AFTER financial_year,
  ADD COLUMN import_batch_row_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_documents_run FOREIGN KEY (research_run_id)
    REFERENCES research_runs(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_documents_import_row FOREIGN KEY (import_batch_row_id)
    REFERENCES import_batch_rows(id) ON DELETE SET NULL;

ALTER TABLE findings
  ADD COLUMN finding_category VARCHAR(80) NOT NULL DEFAULT 'general' AFTER original_value,
  ADD COLUMN numeric_value DECIMAL(20,4) NULL AFTER finding_category,
  ADD COLUMN currency VARCHAR(12) NULL AFTER numeric_value,
  ADD COLUMN unit VARCHAR(40) NULL AFTER currency,
  ADD COLUMN relevant_focus_area TEXT NULL AFTER unit,
  ADD COLUMN provenance ENUM('extracted', 'manual_import', 'researcher_supplied', 'human_verified')
    NOT NULL DEFAULT 'extracted' AFTER extraction_method,
  ADD COLUMN import_batch_row_id BIGINT UNSIGNED NULL AFTER provenance,
  ADD COLUMN reviewer_identity VARCHAR(200) NULL AFTER reviewer_notes,
  ADD KEY idx_findings_category_year (finding_category, financial_year),
  ADD KEY idx_findings_provenance (provenance),
  ADD CONSTRAINT fk_findings_import_row FOREIGN KEY (import_batch_row_id)
    REFERENCES import_batch_rows(id) ON DELETE SET NULL;

UPDATE findings SET provenance = 'researcher_supplied' WHERE extraction_method = 'manual';
UPDATE findings SET finding_category = 'financial'
WHERE field_name IN ('csr_obligation_amount', 'csr_expenditure_amount', 'unspent_csr_amount');

CREATE TABLE finding_review_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  finding_id BIGINT UNSIGNED NOT NULL,
  decision ENUM('pending_review', 'approved', 'rejected', 'unavailable') NOT NULL,
  previous_value TEXT NULL,
  revised_value TEXT NULL,
  previous_financial_year VARCHAR(20) NULL,
  revised_financial_year VARCHAR(20) NULL,
  reviewer_identity VARCHAR(200) NULL,
  reason TEXT NULL,
  reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_review_history_finding (finding_id, reviewed_at),
  CONSTRAINT fk_review_history_finding FOREIGN KEY (finding_id) REFERENCES findings(id) ON DELETE CASCADE
) ENGINE=InnoDB;
