ALTER TABLE attendance_evaluations ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE branch_policies DROP CONSTRAINT IF EXISTS branch_policies_branch_id_effective_from_key;
DROP INDEX IF EXISTS work_schedules_default_date_idx;
ALTER TABLE schedule_assignments ALTER COLUMN schedule_id DROP NOT NULL;
