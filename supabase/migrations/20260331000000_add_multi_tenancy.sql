-- Multi-tenancy: libraries + per-user access control
-- Existing data defaults to 'jemedia' library

-- ── New tables ─────────────────────────────────────────────────────────

CREATE TABLE libraries (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  r2_domain              TEXT NOT NULL DEFAULT 'audio.kohnai.ai',
  transcript_path_prefix TEXT NOT NULL DEFAULT 'transcripts-txt/',
  audio_path_prefix      TEXT NOT NULL DEFAULT '',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE libraries ENABLE ROW LEVEL SECURITY;

CREATE TABLE library_members (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'editor', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, library_id)
);

ALTER TABLE library_members ENABLE ROW LEVEL SECURITY;

-- Users can see libraries they are members of
CREATE POLICY "members_see_libraries" ON libraries
  FOR SELECT TO authenticated
  USING (id IN (SELECT library_id FROM library_members WHERE user_id = auth.uid()));

-- Users can see only their own memberships
CREATE POLICY "users_see_own_memberships" ON library_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ── Seed default library ───────────────────────────────────────────────

INSERT INTO libraries (id, name) VALUES ('jemedia', 'JEM Media');

-- Assign all existing users as admins of the jemedia library
INSERT INTO library_members (user_id, library_id, role)
SELECT id, 'jemedia', 'admin' FROM auth.users;

-- ── Add library_id to content tables (default 'jemedia' for existing rows) ───

ALTER TABLE audio_files      ADD COLUMN library_id TEXT NOT NULL DEFAULT 'jemedia' REFERENCES libraries(id);
ALTER TABLE transcripts       ADD COLUMN library_id TEXT NOT NULL DEFAULT 'jemedia' REFERENCES libraries(id);
ALTER TABLE mappings          ADD COLUMN library_id TEXT NOT NULL DEFAULT 'jemedia' REFERENCES libraries(id);
ALTER TABLE alignments        ADD COLUMN library_id TEXT NOT NULL DEFAULT 'jemedia' REFERENCES libraries(id);
ALTER TABLE reviews           ADD COLUMN library_id TEXT NOT NULL DEFAULT 'jemedia' REFERENCES libraries(id);
ALTER TABLE transcript_edits  ADD COLUMN library_id TEXT NOT NULL DEFAULT 'jemedia' REFERENCES libraries(id);
ALTER TABLE asr_models        ADD COLUMN library_id TEXT NOT NULL DEFAULT 'jemedia' REFERENCES libraries(id);
ALTER TABLE benchmark_results ADD COLUMN library_id TEXT NOT NULL DEFAULT 'jemedia' REFERENCES libraries(id);

-- ── Indexes ────────────────────────────────────────────────────────────

CREATE INDEX idx_audio_files_library      ON audio_files(library_id);
CREATE INDEX idx_transcripts_library      ON transcripts(library_id);
CREATE INDEX idx_mappings_library         ON mappings(library_id);
CREATE INDEX idx_alignments_library       ON alignments(library_id);
CREATE INDEX idx_reviews_library          ON reviews(library_id);
CREATE INDEX idx_transcript_edits_library ON transcript_edits(library_id);

-- ── Helper function for RLS ────────────────────────────────────────────
-- Returns the set of library IDs the current user is a member of.
-- SECURITY DEFINER + STABLE lets Postgres cache it per transaction.

CREATE OR REPLACE FUNCTION public.user_library_ids()
RETURNS SETOF TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT library_id FROM library_members WHERE user_id = auth.uid()
$$;

-- ── RLS policies on content tables ────────────────────────────────────
-- Drop old blanket policies (created by 20260324000000_require_auth.sql),
-- replace with library-scoped policies.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN VALUES ('audio_files'), ('transcripts'), ('mappings'),
                  ('alignments'), ('reviews'), ('transcript_edits'),
                  ('asr_models'), ('benchmark_results')
  LOOP
    -- Drop the old catch-all policy if it exists
    EXECUTE format('DROP POLICY IF EXISTS "authenticated_read_write" ON %I', t);

    EXECUTE format($$
      CREATE POLICY "library_select" ON %I
        FOR SELECT TO authenticated
        USING (library_id IN (SELECT public.user_library_ids()))
    $$, t);

    EXECUTE format($$
      CREATE POLICY "library_insert" ON %I
        FOR INSERT TO authenticated
        WITH CHECK (library_id IN (SELECT public.user_library_ids()))
    $$, t);

    EXECUTE format($$
      CREATE POLICY "library_update" ON %I
        FOR UPDATE TO authenticated
        USING  (library_id IN (SELECT public.user_library_ids()))
        WITH CHECK (library_id IN (SELECT public.user_library_ids()))
    $$, t);

    EXECUTE format($$
      CREATE POLICY "library_delete" ON %I
        FOR DELETE TO authenticated
        USING (library_id IN (SELECT public.user_library_ids()))
    $$, t);
  END LOOP;
END;
$$;

-- ── Update audio_pipeline_status view to include library_id ───────────

DROP VIEW IF EXISTS audio_pipeline_status;

CREATE VIEW audio_pipeline_status AS
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
    WHEN r.status = 'approved'          THEN 'approved'
    WHEN al.audio_id IS NOT NULL        THEN 'aligned'
    WHEN te.audio_id IS NOT NULL        THEN 'cleaned'
    WHEN m.audio_id IS NOT NULL         THEN 'mapped'
    ELSE 'unmapped'
  END AS pipeline_status
FROM audio_files a
LEFT JOIN mappings          m  ON m.audio_id  = a.id
LEFT JOIN transcripts       t  ON t.id        = m.transcript_id
LEFT JOIN alignments        al ON al.audio_id = a.id
LEFT JOIN reviews           r  ON r.audio_id  = a.id
LEFT JOIN transcript_edits  te ON te.audio_id = a.id AND te.version = 'cleaned';
