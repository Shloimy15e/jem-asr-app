-- Admin helper functions for the library management dashboard

-- ── RLS: admins can see all members of their libraries ─────────────────
-- The existing policy only lets users see their own row.
-- This adds a second policy (Supabase ORs multiple SELECT policies).

CREATE POLICY "admins_see_library_members" ON library_members
  FOR SELECT TO authenticated
  USING (
    library_id IN (
      SELECT library_id FROM library_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Admins can update members of their libraries (role changes)
CREATE POLICY "admins_update_library_members" ON library_members
  FOR UPDATE TO authenticated
  USING (
    library_id IN (
      SELECT library_id FROM library_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  )
  WITH CHECK (
    library_id IN (
      SELECT library_id FROM library_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Admins can remove members from their libraries
CREATE POLICY "admins_delete_library_members" ON library_members
  FOR DELETE TO authenticated
  USING (
    library_id IN (
      SELECT library_id FROM library_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Admins can add members to their libraries
CREATE POLICY "admins_insert_library_members" ON library_members
  FOR INSERT TO authenticated
  WITH CHECK (
    library_id IN (
      SELECT library_id FROM library_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Admins can update libraries they administrate
CREATE POLICY "admins_update_libraries" ON libraries
  FOR UPDATE TO authenticated
  USING (
    id IN (
      SELECT library_id FROM library_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  )
  WITH CHECK (
    id IN (
      SELECT library_id FROM library_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- ── create_library() ───────────────────────────────────────────────────
-- Creates a new library and adds the caller as admin in one transaction.
-- Bypasses the INSERT RLS on libraries (which would require pre-existing membership).

CREATE OR REPLACE FUNCTION public.create_library(
  p_id                   TEXT,
  p_name                 TEXT,
  p_r2_domain            TEXT DEFAULT 'audio.kohnai.ai',
  p_transcript_prefix    TEXT DEFAULT 'transcripts-txt/',
  p_audio_prefix         TEXT DEFAULT ''
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO libraries (id, name, r2_domain, transcript_path_prefix, audio_path_prefix)
  VALUES (p_id, p_name, p_r2_domain, p_transcript_prefix, p_audio_prefix);

  INSERT INTO library_members (user_id, library_id, role)
  VALUES (auth.uid(), p_id, 'admin');
END;
$$;

-- ── add_library_member() ───────────────────────────────────────────────
-- Looks up a user by email and adds them to a library.
-- Caller must be admin of that library.
-- Returns the user UUID so the client can display it.

CREATE OR REPLACE FUNCTION public.add_library_member(
  p_library_id TEXT,
  p_email      TEXT,
  p_role       TEXT DEFAULT 'editor'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Verify caller is admin of this library
  IF NOT EXISTS (
    SELECT 1 FROM library_members
    WHERE user_id = auth.uid()
      AND library_id = p_library_id
      AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Access denied: must be admin of library %', p_library_id;
  END IF;

  -- Look up user by email in auth.users (requires SECURITY DEFINER)
  SELECT id INTO v_user_id FROM auth.users WHERE email = p_email;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No account found for email: %', p_email;
  END IF;

  -- Upsert membership (add or update role)
  INSERT INTO library_members (user_id, library_id, role)
  VALUES (v_user_id, p_library_id, p_role)
  ON CONFLICT (user_id, library_id) DO UPDATE SET role = EXCLUDED.role;

  RETURN v_user_id;
END;
$$;

-- ── get_library_members() ──────────────────────────────────────────────
-- Returns all members of a library with their email addresses.
-- Caller must be admin of that library.

CREATE OR REPLACE FUNCTION public.get_library_members(p_library_id TEXT)
RETURNS TABLE (user_id UUID, email TEXT, role TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Verify caller is admin of this library
  IF NOT EXISTS (
    SELECT 1 FROM library_members
    WHERE user_id = auth.uid()
      AND library_id = p_library_id
      AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Access denied: must be admin of library %', p_library_id;
  END IF;

  RETURN QUERY
  SELECT lm.user_id, au.email::TEXT, lm.role, lm.created_at
  FROM library_members lm
  JOIN auth.users au ON au.id = lm.user_id
  WHERE lm.library_id = p_library_id
  ORDER BY lm.created_at;
END;
$$;
