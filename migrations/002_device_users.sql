ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS sync_type TEXT NOT NULL DEFAULT 'attendance'
  CHECK (sync_type IN ('attendance', 'users'));

CREATE TABLE IF NOT EXISTS device_users (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id),
  device_user_id TEXT NOT NULL,
  uid INTEGER,
  name TEXT,
  role INTEGER,
  card_number TEXT,
  raw_data JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_id, device_user_id)
);

CREATE INDEX IF NOT EXISTS device_users_device_name_idx
  ON device_users (device_id, name);
