CREATE TABLE attendance_file_imports (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  file_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  original_content TEXT NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_file_imports_device_content_key UNIQUE (device_id, content_hash),
  CONSTRAINT attendance_file_imports_report_object CHECK (jsonb_typeof(report) = 'object')
);
CREATE INDEX attendance_file_imports_device_created_idx ON attendance_file_imports(device_id, created_at DESC);
