CREATE TABLE whatsapp_conversations (
  id UUID PRIMARY KEY,
  account_sid TEXT NOT NULL,
  business_phone TEXT NOT NULL,
  participant_phone TEXT NOT NULL,
  employee_id UUID REFERENCES employees(id),
  last_inbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_sid, business_phone, participant_phone)
);
CREATE TABLE whatsapp_messages (
  id UUID PRIMARY KEY,
  sequence BIGSERIAL NOT NULL UNIQUE,
  conversation_id UUID NOT NULL REFERENCES whatsapp_conversations(id),
  account_sid TEXT NOT NULL,
  employee_id UUID REFERENCES employees(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  content JSONB NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN ('received','unauthorized','pending','sending','queued','sent','delivered','read','failed','reconciliation')),
  provider_message_id TEXT,
  idempotency_key TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_sid, provider_message_id),
  UNIQUE(conversation_id, idempotency_key)
);
CREATE INDEX whatsapp_messages_pending_idx ON whatsapp_messages(state, next_attempt_at, created_at);
CREATE TABLE whatsapp_attempts (
  id UUID PRIMARY KEY,
  message_id UUID NOT NULL REFERENCES whatsapp_messages(id),
  number INTEGER NOT NULL CHECK (number > 0),
  state TEXT NOT NULL CHECK (state IN ('sending','accepted','rejected','uncertain')),
  provider_message_id TEXT,
  provider_status TEXT,
  error_code TEXT,
  error_message TEXT,
  lease_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(message_id, number)
);
CREATE INDEX whatsapp_attempts_provider_idx ON whatsapp_attempts(provider_message_id);
CREATE TABLE whatsapp_delivery_events (
  id UUID PRIMARY KEY,
  account_sid TEXT NOT NULL,
  business_phone TEXT NOT NULL,
  participant_phone TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  error_code TEXT,
  event_key TEXT NOT NULL,
  correlation_attempt_id UUID,
  attempt_id UUID REFERENCES whatsapp_attempts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_sid, event_key)
);
CREATE INDEX whatsapp_delivery_events_unmatched_idx ON whatsapp_delivery_events(account_sid, provider_message_id, attempt_id);
CREATE TABLE whatsapp_inbox_jobs (
  id UUID PRIMARY KEY,
  message_id UUID NOT NULL UNIQUE REFERENCES whatsapp_messages(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','completed','blocked','awaiting_handler','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX whatsapp_inbox_jobs_pending_idx ON whatsapp_inbox_jobs(state, next_attempt_at, created_at);
