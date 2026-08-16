CREATE SEQUENCE repl_version_seq;

CREATE TABLE changes (
  version bigint PRIMARY KEY DEFAULT nextval('repl_version_seq'),
  account_id bigint NOT NULL REFERENCES accounts(id),
  doc_key text NOT NULL,
  body text NOT NULL,
  written_at timestamptz NOT NULL
);

CREATE INDEX changes_key_version_idx ON changes (account_id, doc_key, version DESC);
CREATE INDEX changes_written_at_idx ON changes (written_at);
