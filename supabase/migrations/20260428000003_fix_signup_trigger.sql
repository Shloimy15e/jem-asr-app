-- ============================================================================
--  Fix: ensure_personal_org_for_user() trigger
-- ----------------------------------------------------------------------------
--  Symptom: every signup via /auth/v1/signup returned 500
--    "Database error saving new user".
--
--  Root cause: when GoTrue (running as `supabase_auth_admin`) inserts a row
--  into auth.users, the AFTER INSERT trigger fires our SECURITY DEFINER
--  function. PG resets `search_path` to a minimal value for SECURITY DEFINER
--  invocations originating from a different role, so unqualified table names
--  like `organizations` were unresolvable from the function body.
--
--  Fix: pin the search_path to `public, pg_temp` AND schema-qualify every
--  INSERT inside the function. Also added a defensive EXCEPTION handler so a
--  bug in the trigger can never again brick auth.users inserts — the user
--  still gets created and we log a WARNING that's captured in the postgres
--  logs for follow-up.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ensure_personal_org_for_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_org_id UUID;
  v_email  TEXT;
  v_name   TEXT;
BEGIN
  v_email := NEW.email;
  v_name  := COALESCE(split_part(v_email, '@', 1), 'My Workspace');

  INSERT INTO public.organizations (name, owner_user_id, is_personal)
  VALUES (v_name || '''s Workspace', NEW.id, TRUE)
  RETURNING id INTO v_org_id;

  INSERT INTO public.org_members (org_id, user_id, role)
  VALUES (v_org_id, NEW.id, 'owner');

  INSERT INTO public.org_credits (org_id, balance_micro_usd, lifetime_topup_micro_usd)
  VALUES (v_org_id, 50000, 50000);

  INSERT INTO public.org_credit_ledger (org_id, delta_micro_usd, reason, description)
  VALUES (v_org_id, 50000, 'free_grant', 'Welcome bonus');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never fail auth.users INSERT — log and continue. The user can still sign
  -- in; missing personal org / credits will be backfilled lazily by the
  -- billing API on next request via resolve_billing_org.
  RAISE WARNING 'ensure_personal_org_for_user failed for user=% (email=%): % / %',
    NEW.id, NEW.email, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$func$;
