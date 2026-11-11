ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_kind_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_kind_check CHECK (kind IN ('absence','late_arrival','early_exit','home_office','client_visit'));
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='leave_requests'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%authorized_time%'
  LOOP EXECUTE format('ALTER TABLE leave_requests DROP CONSTRAINT %I',item.conname); END LOOP;
END $$;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_authorized_time_check CHECK (authorized_time IS NULL OR (kind IN ('late_arrival','early_exit') AND authorized_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'));
ALTER TABLE leave_requests ADD COLUMN client_name text;
ALTER TABLE leave_requests ADD COLUMN full_day boolean NOT NULL DEFAULT true;
ALTER TABLE leave_requests ADD COLUMN replaces_request_id uuid REFERENCES leave_requests(id);
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_client_name_check CHECK (client_name IS NULL OR (kind='client_visit' AND length(btrim(client_name)) BETWEEN 1 AND 200));
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_full_day_check CHECK (full_day OR kind='client_visit');
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_offsite_check CHECK (kind NOT IN ('home_office','client_visit') OR (paid AND NOT use_vacation));
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_replacement_check CHECK (replaces_request_id IS DISTINCT FROM id);
CREATE INDEX leave_requests_replacement_idx ON leave_requests(replaces_request_id);
ALTER TABLE leave_request_events ADD COLUMN previous_status text;
ALTER TABLE leave_request_events ADD COLUMN actor_role text;
