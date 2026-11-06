CREATE TABLE device_clock_adjustments (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE NO ACTION,
  time_zone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  before_reading JSONB,
  target JSONB,
  after_reading JSONB,
  error TEXT,
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ(6)
);
CREATE INDEX device_clock_adjustments_device_started_idx ON device_clock_adjustments (device_id, started_at DESC);
