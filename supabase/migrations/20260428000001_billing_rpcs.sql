-- ============================================================================
--  Billing RPCs — atomic credit ops + entitlement checks
-- ----------------------------------------------------------------------------
--  All credit mutations go through these SECURITY DEFINER functions so the
--  ledger stays the source of truth. Wallet balance is always derived from
--  ledger sum on insert/credit; we cache it on org_credits for O(1) reads.
-- ============================================================================

-- Resolve the owning org for the calling user. Defaults to their personal org;
-- if a specific org_id is provided, verifies membership.
CREATE OR REPLACE FUNCTION public.resolve_billing_org(p_org_id UUID DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_org UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF p_org_id IS NOT NULL THEN
    SELECT org_id INTO v_org
    FROM org_members
    WHERE org_id = p_org_id AND user_id = v_uid
    LIMIT 1;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'org not found or not a member';
    END IF;
    RETURN v_org;
  END IF;

  -- Default to personal org (one where caller is owner + is_personal=true)
  SELECT o.id INTO v_org
  FROM organizations o
  WHERE o.owner_user_id = v_uid AND o.is_personal = TRUE
  ORDER BY o.created_at ASC
  LIMIT 1;

  IF v_org IS NULL THEN
    -- Fall back to first membership
    SELECT om.org_id INTO v_org
    FROM org_members om
    WHERE om.user_id = v_uid
    ORDER BY om.created_at ASC
    LIMIT 1;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'no org for user';
  END IF;
  RETURN v_org;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_billing_org(UUID) TO authenticated;

-- ── Add credits (idempotent on stripe_event_id) ─────────────────────────────
-- Used by /api/stripe-webhook on successful checkout / invoice payment.
CREATE OR REPLACE FUNCTION public.add_org_credits(
  p_org_id UUID,
  p_delta_micro_usd BIGINT,
  p_reason TEXT,
  p_stripe_event_id TEXT DEFAULT NULL,
  p_stripe_payment_intent_id TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ledger_id BIGINT;
  v_new_balance BIGINT;
BEGIN
  IF p_delta_micro_usd <= 0 THEN
    RAISE EXCEPTION 'delta must be positive';
  END IF;

  -- Idempotency check — Stripe webhooks are at-least-once
  IF p_stripe_event_id IS NOT NULL THEN
    SELECT id INTO v_ledger_id FROM org_credit_ledger WHERE stripe_event_id = p_stripe_event_id;
    IF v_ledger_id IS NOT NULL THEN
      SELECT balance_micro_usd INTO v_new_balance FROM org_credits WHERE org_id = p_org_id;
      RETURN json_build_object('ledger_id', v_ledger_id, 'balance_micro_usd', v_new_balance, 'idempotent', TRUE);
    END IF;
  END IF;

  INSERT INTO org_credit_ledger (
    org_id, delta_micro_usd, reason, description, stripe_event_id, stripe_payment_intent_id, metadata
  ) VALUES (
    p_org_id, p_delta_micro_usd, p_reason, p_description, p_stripe_event_id, p_stripe_payment_intent_id, p_metadata
  )
  RETURNING id INTO v_ledger_id;

  INSERT INTO org_credits (org_id, balance_micro_usd, lifetime_topup_micro_usd)
  VALUES (p_org_id, p_delta_micro_usd, p_delta_micro_usd)
  ON CONFLICT (org_id) DO UPDATE SET
    balance_micro_usd = org_credits.balance_micro_usd + EXCLUDED.balance_micro_usd,
    lifetime_topup_micro_usd = org_credits.lifetime_topup_micro_usd + EXCLUDED.balance_micro_usd
  RETURNING balance_micro_usd INTO v_new_balance;

  RETURN json_build_object('ledger_id', v_ledger_id, 'balance_micro_usd', v_new_balance, 'idempotent', FALSE);
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_org_credits(UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, JSONB) TO service_role;

-- ── Reserve / pre-flight check for a transcription ──────────────────────────
-- Returns the active plan + balance + projected charge_to. Does NOT mutate.
CREATE OR REPLACE FUNCTION public.preflight_transcription(
  p_org_id        UUID,
  p_audio_seconds NUMERIC
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_balance BIGINT;
  v_plan RECORD;
  v_minutes NUMERIC := COALESCE(p_audio_seconds, 0) / 60.0;
  v_remaining_min NUMERIC := 0;
  v_can BOOLEAN := FALSE;
  v_charge_to TEXT := 'credits';
BEGIN
  SELECT balance_micro_usd INTO v_balance FROM org_credits WHERE org_id = p_org_id;
  v_balance := COALESCE(v_balance, 0);

  SELECT s.*, p.included_minutes, p.overage_markup_pct
  INTO v_plan
  FROM org_subscriptions s
  JOIN billing_plans p ON p.id = s.plan_id
  WHERE s.org_id = p_org_id
    AND s.status IN ('active', 'trialing')
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF v_plan.id IS NOT NULL THEN
    v_remaining_min := GREATEST(v_plan.included_minutes - v_plan.period_minutes_used, 0);
    IF v_remaining_min >= v_minutes THEN
      v_can := TRUE;
      v_charge_to := 'subscription';
    END IF;
  END IF;

  -- Fall back to credits if subscription doesn't cover it
  IF NOT v_can THEN
    -- We can't compute exact cost here without provider/model; the worker
    -- enforces the actual cost check. Allow if balance > 0 OR free_grant.
    IF v_balance > 0 THEN
      v_can := TRUE;
      v_charge_to := 'credits';
    END IF;
  END IF;

  RETURN json_build_object(
    'allowed', v_can,
    'charge_to', v_charge_to,
    'balance_micro_usd', v_balance,
    'plan_id', v_plan.plan_id,
    'plan_remaining_minutes', v_remaining_min,
    'audio_seconds', p_audio_seconds
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.preflight_transcription(UUID, NUMERIC) TO authenticated, service_role;

-- ── Charge transcription (mutates: ledger + credits + sub.period_minutes_used) ─

CREATE OR REPLACE FUNCTION public.charge_transcription(
  p_usage_id UUID,
  p_charge_to TEXT,
  p_charged_cost_micro_usd BIGINT,
  p_audio_seconds NUMERIC
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_org UUID;
  v_ledger_id BIGINT;
  v_new_balance BIGINT;
BEGIN
  SELECT org_id INTO v_org FROM transcription_usage WHERE id = p_usage_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'usage row not found';
  END IF;

  IF p_charge_to = 'subscription' THEN
    UPDATE org_subscriptions
    SET period_minutes_used = period_minutes_used + (p_audio_seconds / 60.0)
    WHERE org_id = v_org AND status IN ('active', 'trialing')
    RETURNING id INTO v_ledger_id;  -- repurpose var; just to detect any update
    -- No ledger mutation when charging the subscription allowance.
  ELSIF p_charge_to = 'credits' THEN
    -- Atomically deduct, refusing to go below zero.
    UPDATE org_credits
    SET balance_micro_usd = balance_micro_usd - p_charged_cost_micro_usd,
        lifetime_used_micro_usd = lifetime_used_micro_usd + p_charged_cost_micro_usd
    WHERE org_id = v_org AND balance_micro_usd >= p_charged_cost_micro_usd
    RETURNING balance_micro_usd INTO v_new_balance;

    IF v_new_balance IS NULL THEN
      RAISE EXCEPTION 'insufficient credits';
    END IF;

    INSERT INTO org_credit_ledger (org_id, delta_micro_usd, reason, transcription_id, description)
    VALUES (v_org, -p_charged_cost_micro_usd, 'transcription', p_usage_id, 'Transcription charge')
    RETURNING id INTO v_ledger_id;

    UPDATE transcription_usage SET ledger_id = v_ledger_id WHERE id = p_usage_id;
  ELSIF p_charge_to = 'free_grant' THEN
    NULL; -- no-op: e.g. operator-comped run
  ELSE
    RAISE EXCEPTION 'unknown charge_to: %', p_charge_to;
  END IF;

  RETURN json_build_object(
    'ledger_id', v_ledger_id,
    'balance_micro_usd', v_new_balance,
    'charge_to', p_charge_to,
    'charged_cost_micro_usd', p_charged_cost_micro_usd
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.charge_transcription(UUID, TEXT, BIGINT, NUMERIC) TO service_role;

-- ── Refund a transcription (ops tool / failed jobs) ────────────────────────

CREATE OR REPLACE FUNCTION public.refund_transcription(
  p_usage_id UUID,
  p_reason   TEXT DEFAULT 'Auto-refund: transcription failed'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row transcription_usage;
  v_ledger_id BIGINT;
  v_new_balance BIGINT;
BEGIN
  SELECT * INTO v_row FROM transcription_usage WHERE id = p_usage_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'usage row not found';
  END IF;
  IF v_row.status = 'refunded' THEN
    RETURN json_build_object('idempotent', TRUE);
  END IF;

  IF v_row.charged_to = 'credits' AND v_row.charged_cost_micro_usd > 0 THEN
    UPDATE org_credits
    SET balance_micro_usd = balance_micro_usd + v_row.charged_cost_micro_usd,
        lifetime_used_micro_usd = GREATEST(lifetime_used_micro_usd - v_row.charged_cost_micro_usd, 0)
    WHERE org_id = v_row.org_id
    RETURNING balance_micro_usd INTO v_new_balance;

    INSERT INTO org_credit_ledger (org_id, delta_micro_usd, reason, transcription_id, description)
    VALUES (v_row.org_id, v_row.charged_cost_micro_usd, 'refund', p_usage_id, p_reason)
    RETURNING id INTO v_ledger_id;
  ELSIF v_row.charged_to = 'subscription' AND v_row.audio_seconds IS NOT NULL THEN
    UPDATE org_subscriptions
    SET period_minutes_used = GREATEST(period_minutes_used - (v_row.audio_seconds / 60.0), 0)
    WHERE org_id = v_row.org_id AND status IN ('active', 'trialing');
  END IF;

  UPDATE transcription_usage SET status = 'refunded' WHERE id = p_usage_id;

  RETURN json_build_object('refunded', TRUE, 'ledger_id', v_ledger_id, 'balance_micro_usd', v_new_balance);
END;
$$;

GRANT EXECUTE ON FUNCTION public.refund_transcription(UUID, TEXT) TO service_role;

-- ── Apply / sync a Stripe subscription to an org ────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_org_subscription(
  p_org_id        UUID,
  p_plan_id       TEXT,
  p_stripe_sub_id TEXT,
  p_status        TEXT,
  p_period_start  TIMESTAMPTZ,
  p_period_end    TIMESTAMPTZ,
  p_cancel_at_period_end BOOLEAN DEFAULT FALSE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
  v_was_renewal BOOLEAN := FALSE;
  v_existing org_subscriptions;
BEGIN
  SELECT * INTO v_existing FROM org_subscriptions
  WHERE stripe_subscription_id = p_stripe_sub_id;

  IF v_existing.id IS NOT NULL THEN
    -- Detect renewal (period rolled over)
    IF v_existing.current_period_start IS DISTINCT FROM p_period_start
       AND p_status = 'active' THEN
      v_was_renewal := TRUE;
    END IF;

    UPDATE org_subscriptions
    SET plan_id = p_plan_id,
        status = p_status,
        current_period_start = p_period_start,
        current_period_end = p_period_end,
        cancel_at_period_end = p_cancel_at_period_end,
        period_minutes_used = CASE WHEN v_was_renewal THEN 0 ELSE period_minutes_used END
    WHERE id = v_existing.id
    RETURNING id INTO v_id;
  ELSE
    INSERT INTO org_subscriptions (
      org_id, plan_id, stripe_subscription_id, status,
      current_period_start, current_period_end, cancel_at_period_end
    ) VALUES (
      p_org_id, p_plan_id, p_stripe_sub_id, p_status,
      p_period_start, p_period_end, p_cancel_at_period_end
    )
    RETURNING id INTO v_id;
  END IF;

  RETURN json_build_object('id', v_id, 'renewal', v_was_renewal);
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_org_subscription(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) TO service_role;

-- ── Helper: get current billing summary for an org ──────────────────────────
-- Single round-trip for the Billing dashboard.
CREATE OR REPLACE FUNCTION public.org_billing_summary(p_org_id UUID DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_org UUID;
  v_credits org_credits;
  v_sub RECORD;
  v_used_30d NUMERIC := 0;
  v_minutes_30d NUMERIC := 0;
BEGIN
  v_org := public.resolve_billing_org(p_org_id);

  SELECT * INTO v_credits FROM org_credits WHERE org_id = v_org;

  SELECT s.*, p.name AS plan_name, p.included_minutes, p.monthly_price_cents
  INTO v_sub
  FROM org_subscriptions s
  JOIN billing_plans p ON p.id = s.plan_id
  WHERE s.org_id = v_org
    AND s.status IN ('active', 'trialing', 'past_due')
  ORDER BY s.created_at DESC
  LIMIT 1;

  SELECT
    COALESCE(SUM(charged_cost_micro_usd) FILTER (WHERE charged_to = 'credits'), 0),
    COALESCE(SUM(audio_seconds) / 60.0, 0)
  INTO v_used_30d, v_minutes_30d
  FROM transcription_usage
  WHERE org_id = v_org
    AND status = 'completed'
    AND created_at > now() - interval '30 days';

  RETURN json_build_object(
    'org_id', v_org,
    'balance_micro_usd', COALESCE(v_credits.balance_micro_usd, 0),
    'lifetime_topup_micro_usd', COALESCE(v_credits.lifetime_topup_micro_usd, 0),
    'lifetime_used_micro_usd', COALESCE(v_credits.lifetime_used_micro_usd, 0),
    'subscription', CASE WHEN v_sub.id IS NULL THEN NULL ELSE json_build_object(
       'id', v_sub.id,
       'plan_id', v_sub.plan_id,
       'plan_name', v_sub.plan_name,
       'status', v_sub.status,
       'monthly_price_cents', v_sub.monthly_price_cents,
       'included_minutes', v_sub.included_minutes,
       'period_minutes_used', v_sub.period_minutes_used,
       'period_minutes_remaining', GREATEST(v_sub.included_minutes - v_sub.period_minutes_used, 0),
       'current_period_start', v_sub.current_period_start,
       'current_period_end', v_sub.current_period_end,
       'cancel_at_period_end', v_sub.cancel_at_period_end
    ) END,
    'usage_30d', json_build_object(
      'cost_micro_usd', v_used_30d,
      'minutes', v_minutes_30d
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.org_billing_summary(UUID) TO authenticated, service_role;
