-- Add source_transcript_id to transcripts for split-transcript traceability.
-- When a transcript is duplicated (split) so each audio file gets its own copy,
-- the new record's source_transcript_id points back to the original transcript
-- it was derived from, preserving the link to the original document name.

ALTER TABLE public.transcripts
  ADD COLUMN IF NOT EXISTS source_transcript_id TEXT REFERENCES public.transcripts(id);
