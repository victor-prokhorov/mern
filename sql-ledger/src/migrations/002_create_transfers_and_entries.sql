CREATE TABLE transfers (
  id bigserial PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entries (
  id bigserial PRIMARY KEY,
  transfer_id bigint NOT NULL REFERENCES transfers(id),
  account_id bigint NOT NULL REFERENCES accounts(id),
  amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entries_account_id_idx ON entries(account_id);
CREATE INDEX entries_transfer_id_idx ON entries(transfer_id);
