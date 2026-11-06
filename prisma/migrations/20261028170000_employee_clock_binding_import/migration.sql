CREATE TABLE employee_clock_binding_imports (
  id UUID PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  rows JSONB NOT NULL,
  original_data JSONB NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
