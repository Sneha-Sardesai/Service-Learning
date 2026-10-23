USE csr_research;

-- Allow progress_message to store normal progress text safely
ALTER TABLE research_runs
  MODIFY COLUMN progress_message TEXT NOT NULL;

-- Keep link text as evidence for discovered reports
ALTER TABLE documents
  ADD COLUMN link_text VARCHAR(1000) NULL AFTER source_page_url;
