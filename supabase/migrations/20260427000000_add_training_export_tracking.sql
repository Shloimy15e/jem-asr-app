ALTER TABLE audio_files
  ADD COLUMN IF NOT EXISTS training_exported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS training_exported_by TEXT;
