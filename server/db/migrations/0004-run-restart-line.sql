-- Where in the run's log the engine's latest restart begins: a line number, null when the run never restarted.
ALTER TABLE runs ADD COLUMN restarted_at_line INTEGER;
