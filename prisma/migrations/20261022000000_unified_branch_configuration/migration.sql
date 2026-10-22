ALTER TABLE work_schedules
  ADD COLUMN configuration_id UUID,
  ADD COLUMN deleted_at TIMESTAMPTZ;

ALTER TABLE branch_policies
  ADD COLUMN configuration_id UUID,
  ADD COLUMN superseded_from DATE,
  ADD COLUMN deleted_at TIMESTAMPTZ;

CREATE UNIQUE INDEX work_schedules_configuration_id_key ON work_schedules(configuration_id);
CREATE UNIQUE INDEX branch_policies_configuration_id_key ON branch_policies(configuration_id);

ALTER TABLE employee_schedule_versions
  ADD COLUMN meal_mode TEXT CHECK (meal_mode IN ('inherit', 'automatic', 'individual')),
  ADD COLUMN recognition_margin_inherited BOOLEAN NOT NULL DEFAULT FALSE;
