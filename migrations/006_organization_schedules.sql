CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  street TEXT NOT NULL DEFAULT '',
  exterior_number TEXT NOT NULL DEFAULT '',
  interior_number TEXT NOT NULL DEFAULT '',
  neighborhood TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'México',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  manager_name TEXT NOT NULL DEFAULT '',
  time_zone TEXT NOT NULL DEFAULT 'America/Mexico_City',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE devices ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id);
ALTER TABLE device_users ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id);
ALTER TABLE device_users ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id);
ALTER TABLE device_users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id);

CREATE TABLE IF NOT EXISTS branch_assignments (
  id UUID PRIMARY KEY,
  employee_id UUID REFERENCES employees(id),
  device_user_id UUID REFERENCES device_users(id),
  device_id UUID REFERENCES devices(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  effective_from DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (num_nonnulls(employee_id, device_user_id, device_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS branch_assignments_employee_date_idx ON branch_assignments(employee_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS branch_assignments_user_date_idx ON branch_assignments(device_user_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS branch_assignments_device_date_idx ON branch_assignments(device_id, effective_from);

CREATE TABLE IF NOT EXISTS branch_policies (
  id UUID PRIMARY KEY,
  branch_id UUID NOT NULL REFERENCES branches(id),
  effective_from DATE NOT NULL,
  settings JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS work_schedules (
  id UUID PRIMARY KEY,
  branch_id UUID NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  effective_from DATE NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  settings JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS work_schedules_branch_date_idx ON work_schedules(branch_id, effective_from);

CREATE TABLE IF NOT EXISTS schedule_assignments (
  id UUID PRIMARY KEY,
  employee_id UUID REFERENCES employees(id),
  device_user_id UUID REFERENCES device_users(id),
  schedule_id UUID NOT NULL REFERENCES work_schedules(id),
  effective_from DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (num_nonnulls(employee_id, device_user_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_assignments_employee_date_idx ON schedule_assignments(employee_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_assignments_user_date_idx ON schedule_assignments(device_user_id, effective_from);

CREATE TABLE IF NOT EXISTS attendance_evaluations (
  id UUID PRIMARY KEY,
  subject_id UUID NOT NULL,
  employee_id UUID REFERENCES employees(id),
  device_user_id UUID REFERENCES device_users(id),
  date DATE NOT NULL,
  branch_id UUID REFERENCES branches(id),
  schedule_id UUID REFERENCES work_schedules(id),
  policy_id UUID REFERENCES branch_policies(id),
  result JSONB NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subject_id, date),
  CHECK (num_nonnulls(employee_id, device_user_id) = 1)
);
CREATE TABLE IF NOT EXISTS attendance_incidents (
  id UUID PRIMARY KEY,
  evaluation_id UUID NOT NULL REFERENCES attendance_evaluations(id),
  subject_id UUID NOT NULL,
  policy_id UUID NOT NULL REFERENCES branch_policies(id),
  log_id UUID NOT NULL REFERENCES attendance_logs(id),
  kind TEXT NOT NULL CHECK (kind IN ('arrival', 'meal_departure', 'meal_return')),
  occurred_at TIMESTAMPTZ NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (evaluation_id, kind)
);
CREATE TABLE IF NOT EXISTS attendance_deductions (
  id UUID PRIMARY KEY,
  subject_id UUID NOT NULL,
  policy_id UUID NOT NULL REFERENCES branch_policies(id),
  trigger_incident_id UUID NOT NULL UNIQUE REFERENCES attendance_incidents(id),
  category TEXT NOT NULL CHECK (category IN ('arrival', 'meal')),
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  incident_ids UUID[] NOT NULL,
  salary_days INTEGER NOT NULL DEFAULT 1 CHECK (salary_days > 0),
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attendance_incidents_subject_idx ON attendance_incidents(subject_id, occurred_at);
CREATE INDEX IF NOT EXISTS attendance_evaluations_branch_date_idx ON attendance_evaluations(branch_id, date);

CREATE TABLE IF NOT EXISTS organization_initializations (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
