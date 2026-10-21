ALTER TABLE work_schedules ADD COLUMN IF NOT EXISTS superseded_from DATE;

CREATE TABLE IF NOT EXISTS employee_schedule_versions (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES employees(id),
  effective_from DATE NOT NULL,
  work_hours JSONB,
  meal JSONB,
  recognition_margin_minutes INTEGER NOT NULL DEFAULT 30 CHECK (recognition_margin_minutes BETWEEN 0 AND 120),
  source_assignment_id UUID UNIQUE,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (work_hours IS NULL OR jsonb_typeof(work_hours) = 'object'),
  CHECK (meal IS NULL OR jsonb_typeof(meal) = 'object')
);
CREATE INDEX IF NOT EXISTS employee_schedule_versions_employee_date_idx
  ON employee_schedule_versions(employee_id, effective_from DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS schedule_migration_snapshots (
  id UUID PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_type, source_id)
);

INSERT INTO schedule_migration_snapshots (id, source_type, source_id, record)
SELECT gen_random_uuid(), 'work_schedule', s.id, to_jsonb(s) FROM work_schedules s
ON CONFLICT (source_type, source_id) DO NOTHING;
INSERT INTO schedule_migration_snapshots (id, source_type, source_id, record)
SELECT gen_random_uuid(), 'schedule_assignment', a.id, to_jsonb(a) FROM schedule_assignments a
ON CONFLICT (source_type, source_id) DO NOTHING;

INSERT INTO employee_schedule_versions (id, employee_id, effective_from, work_hours, meal, source_assignment_id, source)
SELECT gen_random_uuid(), a.employee_id, a.effective_from,
  CASE WHEN s.id IS NULL OR (s.settings -> 'workDays' = b.settings -> 'workDays'
    AND s.settings ->> 'entryTime' = b.settings ->> 'entryTime' AND s.settings ->> 'exitTime' = b.settings ->> 'exitTime')
    THEN NULL ELSE jsonb_build_object('workDays', s.settings -> 'workDays', 'entryTime', s.settings ->> 'entryTime', 'exitTime', s.settings ->> 'exitTime') END,
  CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('enabled', s.settings -> 'mealEnabled',
    'startTime', s.settings ->> 'mealStart', 'endTime', s.settings ->> 'mealEnd', 'durationMinutes', s.settings -> 'mealDurationMinutes') END,
  a.id, 'legacy_assignment'
FROM schedule_assignments a
LEFT JOIN work_schedules s ON s.id = a.schedule_id
LEFT JOIN LATERAL (
  SELECT settings FROM work_schedules base WHERE base.branch_id = s.branch_id AND base.is_default
    AND base.effective_from <= a.effective_from ORDER BY base.effective_from DESC, base.created_at DESC LIMIT 1
) b ON TRUE
WHERE a.employee_id IS NOT NULL
ON CONFLICT (source_assignment_id) DO NOTHING;

DO $$
DECLARE
  mexico_id UUID;
  first_date DATE;
  new_schedule_id UUID;
  special_employee_id UUID;
  special_first_date DATE;
BEGIN
  SELECT branch_id INTO mexico_id FROM devices WHERE id = 'ffa6b402-8ba2-4bb3-807e-21f84b416713';
  IF mexico_id IS NOT NULL THEN
    SELECT MIN((a.occurred_at AT TIME ZONE b.time_zone)::date) INTO first_date
      FROM attendance_logs a JOIN devices d ON d.id = a.device_id JOIN branches b ON b.id = mexico_id
      WHERE COALESCE(a.branch_id, d.branch_id) = mexico_id;
    IF first_date IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM work_schedules WHERE branch_id = mexico_id AND name = 'México · jornada base 08:30–17:30'
        AND settings ->> 'mealMode' = 'individual'
    ) THEN
      new_schedule_id := gen_random_uuid();
      INSERT INTO work_schedules (id, branch_id, name, effective_from, is_default, settings)
      VALUES (new_schedule_id, mexico_id, 'México · jornada base 08:30–17:30', first_date, TRUE,
        '{"workDays":[1,2,3,4,5],"entryTime":"08:30","exitTime":"17:30","mealEnabled":false,"mealStart":"14:00","mealEnd":"15:00","mealDurationMinutes":60,"mealMode":"individual","recognitionMarginMinutes":30}');
      UPDATE work_schedules SET superseded_from = LEAST(COALESCE(superseded_from, first_date), first_date)
        WHERE branch_id = mexico_id AND is_default AND id <> new_schedule_id;
    END IF;

    SELECT employee_id INTO special_employee_id FROM device_users
      WHERE device_id = 'ffa6b402-8ba2-4bb3-807e-21f84b416713' AND device_user_id = '3040';
    IF special_employee_id IS NOT NULL THEN
      SELECT MIN((a.occurred_at AT TIME ZONE b.time_zone)::date) INTO special_first_date
        FROM attendance_logs a JOIN device_users u ON u.device_id = a.device_id AND u.device_user_id = a.user_id
        JOIN branches b ON b.id = COALESCE(a.branch_id, mexico_id) WHERE u.employee_id = special_employee_id;
      IF special_first_date IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM employee_schedule_versions WHERE employee_id = special_employee_id AND source = 'initial_3040'
      ) THEN
        INSERT INTO employee_schedule_versions (id, employee_id, effective_from, work_hours, meal, source)
        VALUES (gen_random_uuid(), special_employee_id, special_first_date,
          '{"workDays":[1,2,3,4,5],"entryTime":"09:00","exitTime":"18:00"}', NULL, 'initial_3040');
      END IF;
    END IF;
  END IF;
END $$;
