-- Training/audio-first files don't have a transcript to map to. The detail
-- page creates synthetic mappings (transcriptId: null, matchReason:
-- 'created-from-scratch' or 'asr-generated') to let such files enter the
-- cleaning/alignment pipeline. Without this the insert silently fails the
-- NOT NULL constraint and the mapping disappears on reload.
ALTER TABLE mappings ALTER COLUMN transcript_id DROP NOT NULL;
