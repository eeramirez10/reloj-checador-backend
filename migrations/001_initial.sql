CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  tcp_port INTEGER NOT NULL DEFAULT 4370 CHECK (tcp_port BETWEEN 1 AND 65535),
  driver TEXT NOT NULL DEFAULT 'node' CHECK (driver IN ('node', 'sdk-bridge')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sync_interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (sync_interval_seconds BETWEEN 15 AND 86400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  received_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS attendance_logs (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id),
  event_key TEXT NOT NULL,
  device_log_id TEXT,
  user_id TEXT NOT NULL,
  verification_type INTEGER,
  punch_state INTEGER,
  occurred_at TIMESTAMPTZ NOT NULL,
  raw_data JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_id, event_key)
);

CREATE INDEX IF NOT EXISTS attendance_logs_device_occurred_at_idx
  ON attendance_logs (device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_device_started_at_idx
  ON sync_runs (device_id, started_at DESC);
