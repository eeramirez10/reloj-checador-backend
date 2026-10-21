ALTER TABLE branches DROP COLUMN IF EXISTS code;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE device_users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE device_users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE device_users ADD COLUMN IF NOT EXISTS rfc TEXT;
ALTER TABLE device_users ADD COLUMN IF NOT EXISTS imss TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS devices_active_endpoint_idx
  ON devices (ip_address, tcp_port) WHERE deleted_at IS NULL;
