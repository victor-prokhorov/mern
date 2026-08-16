CREATE TABLE alerts (
  id bigserial PRIMARY KEY,
  rule_id bigint NOT NULL REFERENCES alert_rules(id),
  subject text NOT NULL,
  state text NOT NULL DEFAULT 'firing',
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  last_notified_at timestamptz,
  occurrences integer NOT NULL DEFAULT 1,
  consecutive_breaches integer NOT NULL DEFAULT 1,
  consecutive_clears integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX alerts_one_firing_idx ON alerts (rule_id, subject) WHERE state = 'firing';
