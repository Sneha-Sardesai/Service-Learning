CREATE TABLE IF NOT EXISTS research_run_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  research_run_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  step VARCHAR(40) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  source_url VARCHAR(2048) NULL,
  details JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_run_events_run_created (research_run_id, created_at),
  CONSTRAINT fk_run_events_run FOREIGN KEY (research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB;
