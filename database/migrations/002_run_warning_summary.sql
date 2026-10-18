USE csr_research;

ALTER TABLE research_runs
  ADD COLUMN warning_summary TEXT NULL;
