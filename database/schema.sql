CREATE DATABASE IF NOT EXISTS csr_research
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE csr_research;

CREATE TABLE IF NOT EXISTS companies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_name VARCHAR(200) NOT NULL,
  normalized_name VARCHAR(200) NOT NULL,
  cin VARCHAR(21) NULL,
  industry VARCHAR(160) NULL,
  city VARCHAR(160) NULL,
  official_website VARCHAR(2048) NULL,
  website_candidate VARCHAR(2048) NULL,
  official_website_verified_at DATETIME NULL,
  contact_email VARCHAR(254) NULL,
  contact_phone VARCHAR(40) NULL,
  contact_name VARCHAR(200) NULL,
  contact_designation VARCHAR(160) NULL,
  priority VARCHAR(80) NULL,
  data_origin ENUM('researcher_created', 'manual_import') NOT NULL DEFAULT 'researcher_created',
  notes TEXT NULL,
  research_status ENUM('not_started', 'queued', 'running', 'completed', 'partially_completed', 'failed')
    NOT NULL DEFAULT 'not_started',
  last_researched_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_companies_normalized_name (normalized_name),
  KEY idx_companies_cin (cin),
  KEY idx_companies_city (city),
  KEY idx_companies_industry (industry),
  KEY idx_companies_research_status (research_status),
  KEY idx_companies_updated_at (updated_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS company_aliases (
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

CREATE TABLE IF NOT EXISTS import_batches (
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

CREATE TABLE IF NOT EXISTS import_batch_rows (
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

CREATE TABLE IF NOT EXISTS research_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  status ENUM('queued', 'running', 'completed', 'partially_completed', 'failed') NOT NULL DEFAULT 'queued',
  progress_message VARCHAR(200) NOT NULL DEFAULT 'Waiting to start',
  pages_visited INT UNSIGNED NOT NULL DEFAULT 0,
  documents_discovered INT UNSIGNED NOT NULL DEFAULT 0,
  documents_processed INT UNSIGNED NOT NULL DEFAULT 0,
  findings_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_summary TEXT NULL,
  warning_summary TEXT NULL,
  confirmed_domain VARCHAR(2048) NULL,
  summary TEXT NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_runs_company_created (company_id, created_at),
  KEY idx_runs_status (status),
  CONSTRAINT fk_runs_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  research_run_id BIGINT UNSIGNED NULL,
  source_url VARCHAR(2048) NOT NULL,
  url_hash CHAR(64) NOT NULL,
  title VARCHAR(500) NOT NULL,
  file_type VARCHAR(120) NOT NULL DEFAULT 'unknown',
  document_type VARCHAR(80) NULL,
  financial_year VARCHAR(20) NULL,
  publication_date DATE NULL,
  import_batch_row_id BIGINT UNSIGNED NULL,
  content_hash CHAR(64) NULL,
  storage_name VARCHAR(180) NULL,
  extracted_text LONGTEXT NULL,
  processing_status ENUM('discovered', 'processed', 'empty', 'scanned_or_empty', 'encrypted', 'failed', 'unsupported')
    NOT NULL DEFAULT 'discovered',
  processing_error TEXT NULL,
  downloaded_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_documents_company_url (company_id, url_hash),
  KEY idx_documents_company_run (company_id, research_run_id),
  KEY idx_documents_content_hash (content_hash),
  KEY idx_documents_status (processing_status),
  CONSTRAINT fk_documents_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_documents_run FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_documents_import_row FOREIGN KEY (import_batch_row_id) REFERENCES import_batch_rows(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS findings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  research_run_id BIGINT UNSIGNED NULL,
  document_id BIGINT UNSIGNED NULL,
  field_name VARCHAR(120) NOT NULL,
  finding_value TEXT NOT NULL,
  original_value TEXT NOT NULL,
  finding_category VARCHAR(80) NOT NULL DEFAULT 'general',
  numeric_value DECIMAL(20,4) NULL,
  currency VARCHAR(12) NULL,
  unit VARCHAR(40) NULL,
  relevant_focus_area TEXT NULL,
  financial_year VARCHAR(20) NULL,
  source_url VARCHAR(2048) NOT NULL,
  page_number INT UNSIGNED NULL,
  supporting_excerpt TEXT NOT NULL,
  extraction_method ENUM('pattern', 'keyword', 'model', 'manual') NOT NULL DEFAULT 'keyword',
  provenance ENUM('extracted', 'manual_import', 'researcher_supplied', 'human_verified')
    NOT NULL DEFAULT 'extracted',
  import_batch_row_id BIGINT UNSIGNED NULL,
  review_status ENUM('pending_review', 'approved', 'rejected', 'unavailable') NOT NULL DEFAULT 'pending_review',
  evidence_hash CHAR(64) NOT NULL,
  reviewer_notes TEXT NULL,
  reviewer_identity VARCHAR(200) NULL,
  reviewed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_findings_company_evidence (company_id, evidence_hash),
  KEY idx_findings_company_year (company_id, financial_year),
  KEY idx_findings_review_status (review_status),
  KEY idx_findings_document (document_id),
  KEY idx_findings_category_year (finding_category, financial_year),
  KEY idx_findings_provenance (provenance),
  CONSTRAINT fk_findings_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_findings_run FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_findings_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_findings_import_row FOREIGN KEY (import_batch_row_id) REFERENCES import_batch_rows(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS finding_review_history (
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

CREATE TABLE IF NOT EXISTS research_run_documents (
  research_run_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (research_run_id, document_id),
  CONSTRAINT fk_run_documents_run FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_run_documents_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS research_run_findings (
  research_run_id BIGINT UNSIGNED NOT NULL,
  finding_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (research_run_id, finding_id),
  CONSTRAINT fk_run_findings_run FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_run_findings_finding FOREIGN KEY (finding_id) REFERENCES findings(id) ON DELETE CASCADE
) ENGINE=InnoDB;
