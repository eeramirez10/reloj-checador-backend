ALTER TABLE auth_accounts DROP CONSTRAINT auth_accounts_role_check;
ALTER TABLE auth_accounts ADD CONSTRAINT auth_accounts_role_check CHECK (role IN ('admin','hr','manager','employee'));
ALTER TABLE auth_accounts ADD COLUMN employee_id uuid UNIQUE REFERENCES employees(id);
ALTER TABLE auth_accounts ADD COLUMN temporary_password_expires_at timestamptz;

CREATE TABLE blood_types (code text PRIMARY KEY);
INSERT INTO blood_types(code) VALUES ('A+'),('A-'),('B+'),('B-'),('AB+'),('AB-'),('O+'),('O-');
CREATE TABLE employee_contacts (
  employee_id uuid PRIMARY KEY REFERENCES employees(id),
  email text,
  alternate_phone text,
  blood_type text REFERENCES blood_types(code),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_outbox (
  id uuid PRIMARY KEY,
  event_id uuid UNIQUE REFERENCES leave_request_events(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  account_id uuid REFERENCES auth_accounts(id),
  account_version integer,
  kind text NOT NULL CHECK (kind IN ('welcome','leave')),
  recipient text NOT NULL,
  encrypted_content text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','accepted','failed','uncertain','expired')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  expires_at timestamptz NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX email_outbox_pending_idx ON email_outbox(state,next_attempt_at);
