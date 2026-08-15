CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  aggregate text NOT NULL,
  aggregate_id bigint NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
