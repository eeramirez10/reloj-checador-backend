CREATE TABLE IF NOT EXISTS employee_status_events (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES employees(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('initial', 'terminated', 'reactivated')),
  previous_is_active BOOLEAN,
  is_active BOOLEAN NOT NULL,
  local_date DATE NOT NULL,
  time_zone TEXT NOT NULL,
  previous_termination_date DATE,
  termination_date DATE,
  original_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS employee_status_events_employee_date_idx ON employee_status_events(employee_id, created_at DESC);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_active BOOLEAN;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS original_name TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS name_split_method TEXT;

UPDATE employees e SET is_active = NOT (termination_date IS NOT NULL AND termination_date <
  (NOW() AT TIME ZONE COALESCE((SELECT time_zone FROM branches WHERE id = e.branch_id), 'America/Mexico_City'))::date)
WHERE is_active IS NULL;
UPDATE employees SET original_name = name WHERE original_name IS NULL;
ALTER TABLE employees ALTER COLUMN is_active SET DEFAULT TRUE;
ALTER TABLE employees ALTER COLUMN is_active SET NOT NULL;

INSERT INTO employee_status_events (id, employee_id, event_type, is_active, local_date, time_zone,
  previous_termination_date, termination_date, original_data)
SELECT gen_random_uuid(), e.id, 'initial', e.is_active,
  (NOW() AT TIME ZONE COALESCE(b.time_zone, 'America/Mexico_City'))::date,
  COALESCE(b.time_zone, 'America/Mexico_City'), e.termination_date, e.termination_date, to_jsonb(e)
FROM employees e LEFT JOIN branches b ON b.id = e.branch_id
WHERE NOT EXISTS (SELECT 1 FROM employee_status_events event WHERE event.employee_id = e.id);
