ALTER TABLE alerts ADD CONSTRAINT alerts_state_check CHECK (state IN ('pending', 'firing', 'resolved'));
