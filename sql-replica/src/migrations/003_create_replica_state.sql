CREATE TABLE replica_state (
  replica_name text PRIMARY KEY,
  applied_through bigint NOT NULL DEFAULT 0,
  applied_at timestamptz
);
