-- Additive company discovery fields. Existing company and research records stay intact.
ALTER TABLE companies
  ADD COLUMN phase VARCHAR(120) NULL,
  ADD COLUMN region VARCHAR(160) NULL,
  ADD COLUMN headquarters VARCHAR(200) NULL,
  ADD COLUMN turnover_amount DECIMAL(20,4) NULL,
  ADD COLUMN turnover_currency VARCHAR(12) NULL,
  ADD COLUMN turnover_unit VARCHAR(40) NULL,
  ADD COLUMN turnover_original VARCHAR(255) NULL,
  ADD KEY idx_companies_phase (phase),
  ADD KEY idx_companies_region (region),
  ADD KEY idx_companies_turnover (turnover_currency, turnover_unit, turnover_amount);

CREATE TABLE IF NOT EXISTS company_focus_areas (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  focus_area VARCHAR(200) NOT NULL,
  normalized_focus_area VARCHAR(200) NOT NULL,
  source_value TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_focus_area (company_id, normalized_focus_area),
  KEY idx_focus_area (normalized_focus_area),
  CONSTRAINT fk_focus_area_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS company_source_values (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  source_workbook VARCHAR(255) NOT NULL,
  source_worksheet VARCHAR(255) NOT NULL,
  source_row INT UNSIGNED NOT NULL,
  source_column VARCHAR(255) NOT NULL,
  original_value TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_source_cell (company_id, source_workbook, source_worksheet, source_row, source_column),
  KEY idx_company_source (company_id, source_workbook),
  CONSTRAINT fk_company_source_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB;
