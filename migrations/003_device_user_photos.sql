DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'sync_runs'::regclass
      AND conname = 'sync_runs_sync_type_check'
      AND pg_get_constraintdef(oid) LIKE '%user_photos%'
  ) THEN
    ALTER TABLE sync_runs DROP CONSTRAINT IF EXISTS sync_runs_sync_type_check;
    ALTER TABLE sync_runs
      ADD CONSTRAINT sync_runs_sync_type_check
      CHECK (sync_type IN ('attendance', 'users', 'user_photos'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS device_user_photos (
  device_id UUID NOT NULL,
  device_user_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type = 'image/jpeg'),
  image_data BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, device_user_id),
  FOREIGN KEY (device_id, device_user_id)
    REFERENCES device_users (device_id, device_user_id)
    ON DELETE CASCADE
);
