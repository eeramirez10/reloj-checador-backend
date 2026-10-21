ALTER TABLE employees ALTER COLUMN employee_number DROP NOT NULL;
ALTER TABLE employees ALTER COLUMN normalized_employee_number DROP NOT NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS identification_status TEXT NOT NULL DEFAULT 'confirmed'
  CHECK (identification_status IN ('confirmed', 'pending', 'merged'));
ALTER TABLE employees ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES employees(id);
ALTER TABLE device_users ADD COLUMN IF NOT EXISTS binding_status TEXT NOT NULL DEFAULT 'active'
  CHECK (binding_status IN ('active', 'historical'));

CREATE TABLE IF NOT EXISTS employee_unification_snapshots (
  id UUID PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_type, source_id)
);

CREATE TABLE IF NOT EXISTS employee_merge_events (
  id UUID PRIMARY KEY,
  source_employee_id UUID NOT NULL REFERENCES employees(id),
  target_employee_id UUID NOT NULL REFERENCES employees(id),
  original_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source_employee_id <> target_employee_id)
);

CREATE TABLE IF NOT EXISTS employee_clock_events (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES employees(id),
  device_user_id UUID NOT NULL REFERENCES device_users(id),
  previous_device_user_id UUID REFERENCES device_users(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization_initializations WHERE code = 'employee-unification-v1') THEN
    INSERT INTO employee_unification_snapshots (id, source_type, source_id, record)
      SELECT gen_random_uuid(), 'employee', id, to_jsonb(e) FROM employees e;
    INSERT INTO employee_unification_snapshots (id, source_type, source_id, record)
      SELECT gen_random_uuid(), 'device_user', id, to_jsonb(u) FROM device_users u;
    INSERT INTO employee_unification_snapshots (id, source_type, source_id, record)
      SELECT gen_random_uuid(), 'branch_assignment', id, to_jsonb(a) FROM branch_assignments a;
    INSERT INTO employee_unification_snapshots (id, source_type, source_id, record)
      SELECT gen_random_uuid(), 'schedule_assignment', id, to_jsonb(a) FROM schedule_assignments a;
    INSERT INTO employee_unification_snapshots (id, source_type, source_id, record)
      SELECT gen_random_uuid(), 'evaluation', id, to_jsonb(e) FROM attendance_evaluations e;

    INSERT INTO device_users (id, device_id, device_user_id, raw_data, branch_id)
      SELECT gen_random_uuid(), history.device_id, history.user_id, '{"source":"attendance_history"}'::jsonb,
        COALESCE(history.branch_id, d.branch_id)
      FROM (SELECT DISTINCT ON (a.device_id, a.user_id) a.device_id, a.user_id, a.branch_id
        FROM attendance_logs a WHERE NOT EXISTS (
          SELECT 1 FROM device_users u WHERE u.device_id = a.device_id AND u.device_user_id = a.user_id
        ) ORDER BY a.device_id, a.user_id, a.occurred_at DESC) history
      JOIN devices d ON d.id = history.device_id;

    INSERT INTO employees (id, name, first_name, last_name, rfc, imss, branch_id, identification_status, created_at, updated_at)
      SELECT u.id, COALESCE(NULLIF(u.display_name, ''), NULLIF(u.name, ''), 'Registro ' || u.device_user_id),
        u.first_name, u.last_name, u.rfc, u.imss, COALESCE(u.branch_id, d.branch_id), 'pending', u.synced_at, u.synced_at
      FROM device_users u JOIN devices d ON d.id = u.device_id WHERE u.employee_id IS NULL;
    UPDATE device_users SET employee_id = id WHERE employee_id IS NULL;

    INSERT INTO branch_assignments (id, employee_id, branch_id, effective_from)
      SELECT gen_random_uuid(), u.employee_id, a.branch_id, a.effective_from
      FROM branch_assignments a JOIN device_users u ON u.id = a.device_user_id
      ON CONFLICT (employee_id, effective_from) DO NOTHING;
    INSERT INTO branch_assignments (id, employee_id, branch_id, effective_from)
      SELECT gen_random_uuid(), id, branch_id, '1900-01-01' FROM employees e
      WHERE branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branch_assignments a WHERE a.employee_id = e.id);
    INSERT INTO schedule_assignments (id, employee_id, schedule_id, effective_from)
      SELECT gen_random_uuid(), u.employee_id, a.schedule_id, a.effective_from
      FROM schedule_assignments a JOIN device_users u ON u.id = a.device_user_id
      ON CONFLICT (employee_id, effective_from) DO NOTHING;
    UPDATE attendance_evaluations e SET employee_id = u.employee_id, device_user_id = NULL
      FROM device_users u WHERE e.device_user_id = u.id;

    WITH ranked AS (
      SELECT u.id, row_number() OVER (PARTITION BY u.employee_id ORDER BY
        CASE WHEN e.branch_id = d.branch_id THEN 0 ELSE 1 END, u.synced_at DESC, u.id) AS position
      FROM device_users u JOIN employees e ON e.id = u.employee_id JOIN devices d ON d.id = u.device_id
    ) UPDATE device_users u SET binding_status = CASE WHEN ranked.position = 1 THEN 'active' ELSE 'historical' END
      FROM ranked WHERE ranked.id = u.id;
    INSERT INTO employee_clock_events (id, employee_id, device_user_id, reason)
      SELECT gen_random_uuid(), employee_id, id, 'migration' FROM device_users WHERE binding_status = 'active';
    INSERT INTO organization_initializations (id, code) VALUES (gen_random_uuid(), 'employee-unification-v1');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS device_users_active_employee_idx
  ON device_users(employee_id) WHERE binding_status = 'active';
CREATE INDEX IF NOT EXISTS employees_identification_status_idx ON employees(identification_status);
ALTER TABLE device_users ALTER COLUMN employee_id SET NOT NULL;
