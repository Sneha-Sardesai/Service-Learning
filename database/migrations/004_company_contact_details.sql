USE csr_research;

ALTER TABLE companies
  ADD COLUMN contact_name VARCHAR(200) NULL AFTER contact_phone,
  ADD COLUMN contact_designation VARCHAR(160) NULL AFTER contact_name;
