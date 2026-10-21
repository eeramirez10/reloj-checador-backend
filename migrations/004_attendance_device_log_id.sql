WITH attendance_serials AS (
  SELECT
    id,
    device_id,
    raw_data ->> 'userSn' AS device_log_id,
    COUNT(*) OVER (PARTITION BY device_id, raw_data ->> 'userSn') AS serial_count
  FROM attendance_logs
  WHERE device_log_id IS NULL
    AND jsonb_typeof(raw_data -> 'userSn') IN ('number', 'string')
    AND raw_data ->> 'userSn' ~ '^[0-9]+$'
), unique_attendance_serials AS (
  SELECT id, device_id, device_log_id
  FROM attendance_serials candidate
  WHERE serial_count = 1
    AND NOT EXISTS (
      SELECT 1
      FROM attendance_logs existing
      WHERE existing.device_id = candidate.device_id
        AND existing.id <> candidate.id
        AND existing.event_key = candidate.device_log_id
    )
)
UPDATE attendance_logs AS attendance
SET device_log_id = candidate.device_log_id,
    event_key = candidate.device_log_id
FROM unique_attendance_serials AS candidate
WHERE attendance.id = candidate.id;
