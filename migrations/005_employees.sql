CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY,
  employee_number TEXT NOT NULL UNIQUE CHECK (employee_number ~ '^[0-9]{8}$'),
  normalized_employee_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  position TEXT,
  rfc TEXT,
  imss TEXT,
  management_code TEXT,
  section_code TEXT,
  company_code TEXT,
  branch_code TEXT,
  schedule_type_code TEXT,
  hire_date DATE,
  termination_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS employees_branch_name_idx
  ON employees (branch_code, name);
