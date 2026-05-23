CREATE TABLE webhooks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL DEFAULT '',
  events     TEXT[] NOT NULL DEFAULT '{group_completed,group_timed_out}',
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE webhook_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id       UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL,
  group_id         TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INT NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,
  response_status  INT,
  response_body    TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX ON webhook_deliveries (status, created_at DESC);
