-- Restores the previous schema. Removed display aliases require a database
-- backup to recover their original values.
ALTER TABLE clients ADD COLUMN remark text NOT NULL DEFAULT '';
