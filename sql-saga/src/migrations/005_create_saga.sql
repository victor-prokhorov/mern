CREATE TABLE saga (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  order_id bigint REFERENCES orders(id),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'compensating', 'compensated', 'failed')),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saga_steps (
  id bigserial PRIMARY KEY,
  saga_id bigint NOT NULL REFERENCES saga(id),
  position integer NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('compensatable', 'pivot', 'retryable')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'compensated', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (saga_id, position)
);

CREATE INDEX saga_steps_saga_idx ON saga_steps (saga_id, position);
