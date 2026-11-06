ALTER TABLE device_clock_adjustments
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'server' CHECK (mode IN ('server','manual')),
  ADD COLUMN requested_local_time TEXT,
  ADD CONSTRAINT device_clock_adjustments_request_check CHECK (
    (mode = 'server' AND requested_local_time IS NULL) OR
    (mode = 'manual' AND requested_local_time IS NOT NULL)
  );
