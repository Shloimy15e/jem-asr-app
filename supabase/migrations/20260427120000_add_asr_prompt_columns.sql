-- Add per-row prompt metadata for Vertex/Gemini-prompted ASR runs.
-- Whisper / Mendel rows leave these NULL.
--
-- Why also a per-run id-style version key? With prompts, the same
-- (audio, gemini-endpoint) pair can produce multiple distinct transcripts,
-- one per (prompt, run). To keep each one as its own row we suffix the
-- version key with a unix-ms timestamp, e.g.
--   asr-gemini-yiddish-v3-large-1730000000000
-- The (audio_id, version) UNIQUE constraint stays intact — every run has
-- a distinct timestamp suffix, so no upsert collisions.

ALTER TABLE public.transcript_edits ADD COLUMN IF NOT EXISTS prompt TEXT;
ALTER TABLE public.transcript_edits ADD COLUMN IF NOT EXISTS prompt_label TEXT;
