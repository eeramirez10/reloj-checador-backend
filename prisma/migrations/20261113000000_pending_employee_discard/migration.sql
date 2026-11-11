ALTER TABLE employees ADD COLUMN discarded_at timestamptz;
ALTER TABLE employees ADD CONSTRAINT employees_discard_pending_check CHECK (discarded_at IS NULL OR identification_status='pending');

CREATE TABLE employee_discard_events (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  kind text NOT NULL CHECK (kind IN ('discarded','restored')),
  actor_account_id uuid REFERENCES auth_accounts(id),
  attendance_log_id uuid REFERENCES attendance_logs(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_discard_events_employee_idx ON employee_discard_events(employee_id,created_at);

CREATE FUNCTION restore_discarded_employee_from_attendance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH restored AS (
    UPDATE employees e SET discarded_at=NULL,updated_at=now()
    WHERE e.discarded_at IS NOT NULL AND e.id IN (
      SELECT u.employee_id FROM device_users u WHERE u.device_id=NEW.device_id AND u.device_user_id=NEW.user_id
    ) RETURNING e.id
  ), recorded AS (
    INSERT INTO employee_discard_events(id,employee_id,kind,attendance_log_id,reason)
    SELECT gen_random_uuid(),id,'restored',NEW.id,'Recuperado automáticamente al recibir una checada.' FROM restored
    RETURNING id
  )
  INSERT INTO auth_audit_events(id,action,target_id,metadata)
  SELECT gen_random_uuid(),'employee_restored_from_attendance',id,
    jsonb_build_object('logId',NEW.id,'deviceId',NEW.device_id,'userId',NEW.user_id) FROM restored;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attendance_restore_discarded_employee AFTER INSERT ON attendance_logs
FOR EACH ROW EXECUTE FUNCTION restore_discarded_employee_from_attendance();
