CREATE TABLE employee_leave_profiles (
  employee_id UUID PRIMARY KEY REFERENCES employees(id),
  manager_id UUID REFERENCES employees(id),
  whatsapp_phone TEXT UNIQUE,
  vacation_balance INTEGER NOT NULL DEFAULT 0 CHECK (vacation_balance >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (manager_id IS DISTINCT FROM employee_id),
  CHECK (whatsapp_phone IS NULL OR whatsapp_phone ~ '^\+[1-9][0-9]{7,14}$')
);
CREATE TABLE leave_requests (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES employees(id),
  manager_id UUID NOT NULL REFERENCES employees(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  kind TEXT NOT NULL CHECK (kind IN ('absence','late_arrival','early_exit')),
  from_date DATE NOT NULL,
  to_date DATE NOT NULL CHECK (to_date >= from_date),
  authorized_time TEXT,
  paid BOOLEAN NOT NULL,
  use_vacation BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  details JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','whatsapp')),
  source_key TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES employees(id),
  CHECK (NOT use_vacation OR (kind = 'absence' AND paid)),
  CHECK ((kind = 'absence' AND authorized_time IS NULL) OR (kind <> 'absence' AND authorized_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
);
CREATE INDEX leave_requests_employee_dates_idx ON leave_requests(employee_id, from_date, to_date);
CREATE INDEX leave_requests_status_created_idx ON leave_requests(status, created_at DESC);
CREATE TABLE vacation_movements (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES employees(id),
  request_id UUID REFERENCES leave_requests(id),
  kind TEXT NOT NULL CHECK (kind IN ('adjustment','consumption','return')),
  days INTEGER NOT NULL CHECK (days <> 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(request_id, kind)
);
CREATE INDEX vacation_movements_employee_created_idx ON vacation_movements(employee_id, created_at DESC);
CREATE TABLE leave_request_events (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES leave_requests(id),
  kind TEXT NOT NULL CHECK (kind IN ('created','approved','rejected','cancelled')),
  actor_employee_id UUID REFERENCES employees(id),
  comments TEXT NOT NULL DEFAULT '',
  recipient_employee_id UUID NOT NULL REFERENCES employees(id),
  recipient_phone TEXT,
  notification_status TEXT NOT NULL DEFAULT 'awaiting_configuration',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX leave_request_events_request_created_idx ON leave_request_events(request_id, created_at);
