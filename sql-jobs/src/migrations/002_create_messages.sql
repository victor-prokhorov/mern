CREATE TABLE messages (
  id serial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts (id),
  recipient text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_account_id_idx ON messages (account_id);
