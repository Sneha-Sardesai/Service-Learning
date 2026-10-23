USE csr_research;

-- Persist report provenance and validation without altering existing records.
ALTER TABLE documents
  ADD COLUMN source_page_url VARCHAR(2048) NULL AFTER source_url,
  ADD COLUMN validation_result VARCHAR(1000) NULL AFTER processing_error,
  MODIFY COLUMN processing_status ENUM(
    'discovered', 'processed', 'empty', 'scanned_or_empty', 'encrypted',
    'failed', 'unsupported', 'skipped', 'not_processed'
  ) NOT NULL DEFAULT 'discovered';
