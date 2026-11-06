CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','hr','manager')),
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_account_branches (
  account_id uuid NOT NULL REFERENCES auth_accounts(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  PRIMARY KEY (account_id,branch_id)
);
CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES auth_accounts(id),
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX auth_sessions_account_idx ON auth_sessions(account_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE auth_audit_events (
  id uuid PRIMARY KEY,
  account_id uuid REFERENCES auth_accounts(id),
  action text NOT NULL,
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_audit_account_date_idx ON auth_audit_events(account_id,created_at DESC);
ALTER TABLE leave_request_events ADD COLUMN actor_account_id uuid REFERENCES auth_accounts(id);
ALTER TABLE vacation_movements ADD COLUMN actor_account_id uuid REFERENCES auth_accounts(id);
