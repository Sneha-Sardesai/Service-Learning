USE csr_research;

-- Apply once to databases created from the previous schema.sql. These changes
-- add data only; they do not remove or overwrite existing research records.
ALTER TABLE findings
  ADD COLUMN original_value TEXT NULL;

UPDATE findings
SET original_value = finding_value
WHERE original_value IS NULL;

CREATE TABLE research_run_documents (
  research_run_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (research_run_id, document_id),
  CONSTRAINT fk_run_documents_run FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_run_documents_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE research_run_findings (
  research_run_id BIGINT UNSIGNED NOT NULL,
  finding_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (research_run_id, finding_id),
  CONSTRAINT fk_run_findings_run FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_run_findings_finding FOREIGN KEY (finding_id) REFERENCES findings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT IGNORE INTO research_run_documents (research_run_id, document_id)
SELECT research_run_id, id
FROM documents;

INSERT IGNORE INTO research_run_findings (research_run_id, finding_id)
SELECT research_run_id, id
FROM findings
WHERE research_run_id IS NOT NULL;
