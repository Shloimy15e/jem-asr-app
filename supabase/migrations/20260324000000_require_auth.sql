-- Require authentication for all data access.
-- Drops the existing anon read/write policies and replaces them with
-- authenticated-only policies so the app is not publicly accessible.

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'audio_files', 'transcripts', 'mappings', 'alignments',
    'reviews', 'transcript_edits', 'asr_models', 'benchmark_results'
  ]
  LOOP
    -- Drop any existing open policies (names may vary)
    EXECUTE format('DROP POLICY IF EXISTS "public_read_write" ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "anon_read_write" ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "allow_all" ON %I', tbl);
    -- Create authenticated-only policy
    EXECUTE format(
      'CREATE POLICY "authenticated_read_write" ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;
