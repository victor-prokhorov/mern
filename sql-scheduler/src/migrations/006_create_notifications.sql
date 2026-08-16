CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  alert_id bigint NOT NULL REFERENCES alerts(id),
  channel text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
