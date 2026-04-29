ALTER TABLE audio_files
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_audio_files_created_at
  ON audio_files (library_id, created_at DESC);
