-- Track which audio files have been pushed to KolYid (yiddish-cleaner) via
-- the "Send to KolYid" button. Filled by functions/api/send-to-kolyid.js
-- after a successful 201 from KolYid's /api/imports/jem-asr endpoint.
--
-- kolyid_transcript_url is the click-through link returned in KolYid's 201
-- response — used by the table badge so reviewers can jump to the imported
-- record on KolYid in one click.
ALTER TABLE audio_files
  ADD COLUMN IF NOT EXISTS kolyid_imported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kolyid_imported_by TEXT,
  ADD COLUMN IF NOT EXISTS kolyid_transcript_url TEXT;
