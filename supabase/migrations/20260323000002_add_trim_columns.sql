-- Add audio range selection columns to audio_files
ALTER TABLE audio_files ADD COLUMN IF NOT EXISTS trim_start FLOAT DEFAULT 0;
ALTER TABLE audio_files ADD COLUMN IF NOT EXISTS trim_end FLOAT DEFAULT 0;
