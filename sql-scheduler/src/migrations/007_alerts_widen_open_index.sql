DROP INDEX alerts_one_firing_idx;

CREATE UNIQUE INDEX alerts_one_open_idx ON alerts (rule_id, subject) WHERE state <> 'resolved';
