CREATE TABLE companies (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  code text CHECK (code IS NULL OR length(btrim(code)) BETWEEN 1 AND 50),
  active boolean NOT NULL DEFAULT true,
  notes text NOT NULL DEFAULT '' CHECK (length(notes)<=2000),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_name_key ON companies(lower(btrim(name)));
CREATE UNIQUE INDEX companies_code_key ON companies(lower(btrim(code))) WHERE code IS NOT NULL;
ALTER TABLE employees ADD COLUMN company_id uuid REFERENCES companies(id);
CREATE INDEX employees_branch_company_idx ON employees(branch_id,company_id,is_active) WHERE identification_status<>'merged';
