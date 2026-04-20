-- Unify cleaning into the `edited` version row.
-- Before: `transcript_edits` stored two rows per audio — `version='cleaned'` (written by
--         batch-clean and split flow) and `version='edited'` (written by the editor).
--         The `cleaned` row existed only to feed the audio_pipeline_status view.
-- After:  cleaning metadata (original_text, clean_rate) lives on the same `edited` row.
--         The `cleaned` version value is retired from transcript_edits.

-- ── Step 1: Promote orphan cleaned rows to edited ─────────────────────
-- If an audio has a `cleaned` row but no `edited` row, rename it to `edited`.
-- The UPSERT conflict key is (audio_id, version) so a plain UPDATE is safe.
UPDATE public.transcript_edits AS c
SET version = 'edited'
WHERE c.version = 'cleaned'
  AND NOT EXISTS (
    SELECT 1 FROM public.transcript_edits e
    WHERE e.audio_id   = c.audio_id
      AND e.library_id = c.library_id
      AND e.version    = 'edited'
  );

-- ── Step 2: Merge cleaning metadata from surviving cleaned rows into edited ─
-- For any audio that already had an edited row AND a cleaned row, the cleaned
-- row's cleaning metadata (original_text + clean_rate) is moved onto the edited
-- row so the cleaning history isn't lost. Text itself is NOT overwritten — the
-- edited row's text wins (it's presumed to be the user's latest working copy).
UPDATE public.transcript_edits AS e
SET
  original_text = COALESCE(e.original_text, c.original_text),
  clean_rate    = COALESCE(e.clean_rate,    c.clean_rate)
FROM public.transcript_edits AS c
WHERE e.version    = 'edited'
  AND c.version    = 'cleaned'
  AND c.audio_id   = e.audio_id
  AND c.library_id = e.library_id;

-- ── Step 3: Delete remaining cleaned rows ─────────────────────────────
DELETE FROM public.transcript_edits
WHERE version = 'cleaned';

-- ── Step 4: Rewrite audio_pipeline_status view ────────────────────────
-- "cleaned" pipeline stage is now presence of an edited row for the audio.
-- Keeps existing column names so table/admin code doesn't break.
DROP VIEW IF EXISTS public.audio_pipeline_status;

CREATE VIEW public.audio_pipeline_status AS
SELECT
  a.id,
  a.name,
  a.library_id,
  a.is_selected_50hr,
  a.is_benchmark,
  m.transcript_id,
  t.name AS transcript_name,
  m.confidence AS mapping_confidence,
  CASE
    WHEN r.status = 'approved'     THEN 'approved'
    WHEN al.audio_id IS NOT NULL   THEN 'aligned'
    WHEN te.audio_id IS NOT NULL   THEN 'cleaned'
    WHEN m.audio_id IS NOT NULL    THEN 'mapped'
    ELSE 'unmapped'
  END AS pipeline_status
FROM public.audio_files a
LEFT JOIN public.mappings         m  ON m.audio_id  = a.id
LEFT JOIN public.transcripts      t  ON t.id        = m.transcript_id
LEFT JOIN public.alignments       al ON al.audio_id = a.id
LEFT JOIN public.reviews          r  ON r.audio_id  = a.id
LEFT JOIN public.transcript_edits te ON te.audio_id = a.id AND te.version = 'edited';
