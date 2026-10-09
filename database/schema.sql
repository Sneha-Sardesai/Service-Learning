CREATE DATABASE IF NOT EXISTS csr_research
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE csr_research;

CREATE TABLE IF NOT EXISTS companies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_name VARCHAR(200) NOT NULL,
  normalized_name VARCHAR(200) NOT NULL,
  industry VARCHAR(160) NULL,
  official_website VARCHAR(2048) NULL,
  notes TEXT NULL,
  research_status ENUM('not_started', 'queued', 'running', 'completed', 'partially_completed', 'failed')
    NOT NULL DEFAULT 'not_started',
  last_researched_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_companies_normalized_name (normalized_name),
  KEY idx_companies_industry (industry),
  KEY idx_companies_research_status (research_status),
  KEY idx_companies_updated_at (updated_at)
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
  research_run_id BIGINT UNSIGNED NOT NULL,
  source_url VARCHAR(2048) NOT NULL,
  url_hash CHAR(64) NOT NULL,
  title VARCHAR(500) NOT NULL,
  file_type VARCHAR(120) NOT NULL DEFAULT 'unknown',
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
  CONSTRAINT fk_documents_run FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS findings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  research_run_id BIGINT UNSIGNED NULL,
  document_id BIGINT UNSIGNED NULL,
  field_name VARCHAR(120) NOT NULL,
  finding_value TEXT NOT NULL,
  financial_year VARCHAR(20) NULL,
  source_url VARCHAR(2048) NOT NULL,
  page_number INT UNSIGNED NULL,
  supporting_excerpt TEXT NOT NULL,
  extraction_method ENUM('pattern', 'keyword', 'model', 'manual') NOT NULL DEFAULT 'keyword',
  review_status ENUM('pending_review', 'approved', 'rejected', 'unavailable') NOT NULL DEFAULT 'pending_review',
  evidence_hash CHAR(64) NOT NULL,
  reviewer_notes TEXT NULL,
  reviewed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_findings_company_evidence (company_id, evidence_hash),
  KEY idx_findings_company_year (company_id, financial_year),
  KEY idx_findings_review_status (review_status),
  KEY idx_findings_document (document_id),
  CONSTRAINT fk_findings_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_findings_run FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_findings_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL
) ENGINE=InnoDB;
