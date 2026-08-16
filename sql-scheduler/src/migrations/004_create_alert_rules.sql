CREATE TABLE alert_rules (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  threshold numeric NOT NULL,
  window_seconds integer NOT NULL,
  for_evaluations integer NOT NULL DEFAULT 1,
  cooldown_seconds integer NOT NULL DEFAULT 300,
  channel text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
