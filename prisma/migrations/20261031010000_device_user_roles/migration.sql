ALTER TABLE device_users ADD COLUMN role_observed_at TIMESTAMPTZ;
CREATE TABLE device_user_role_changes (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES employees(id),
  clock_record_id UUID NOT NULL REFERENCES device_users(id),
  device_id UUID NOT NULL REFERENCES devices(id),
  user_id TEXT NOT NULL,
  requested_role INTEGER NOT NULL CHECK (requested_role IN (0,14)),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','blocked','failed','unconfirmed')),
  before_reading JSONB,
  after_reading JSONB,
  code TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX device_user_role_changes_employee_started_idx ON device_user_role_changes(employee_id,started_at DESC);
