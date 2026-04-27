-- ============================================================================
--  End-User Multi-Tenancy + Billing Schema
-- ----------------------------------------------------------------------------
--  Adds a parallel tenancy layer on top of the existing internal `libraries`
--  model. Internal staff continue to use libraries; paying end users live in
--  `organizations`. Each authed user automatically gets a personal org and may
--  also belong to shared orgs (B2B teams) — billing rolls up to the org owner.
--
--  Cost flow:
--     transcription_usage ──cost calc──▶ org_credit_ledger ──balance──▶
--        org_credits.balance_micro_usd
--     stripe payments ──webhook──▶ org_credit_ledger (+ ledger reasons)
--     subscriptions provide a monthly minute allowance; overage drains credits
--
--  All money is stored in micro-USD (1,000,000 = $1.00) for precision.
--  All time-based usage is stored in seconds (audio_seconds, pod_seconds).
-- ============================================================================

-- ── Organizations (end-user tenants) ─────────────────────────────────────────

CREATE TABLE organizations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE,
  owner_user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  is_personal     BOOLEAN NOT NULL DEFAULT TRUE,
  stripe_customer_id TEXT UNIQUE,
  default_markup_pct NUMERIC(6,2) NOT NULL DEFAULT 30.00,  -- 30% markup over raw provider cost
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orgs_owner ON organizations(owner_user_id);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- ── Org membership (which users belong to which orgs) ────────────────────────

CREATE TABLE org_members (
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX idx_org_members_user ON org_members(user_id);

ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;

-- Helper: SECURITY DEFINER function so RLS policies can resolve membership
-- without recursion.
CREATE OR REPLACE FUNCTION public.user_org_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT org_id FROM org_members WHERE user_id = auth.uid()
$$;

CREATE POLICY "org_members_see_own" ON org_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR org_id IN (SELECT public.user_org_ids()));

CREATE POLICY "org_members_see_orgs" ON organizations
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.user_org_ids()));

CREATE POLICY "org_owner_update" ON organizations
  FOR UPDATE TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- ── Billing plans ────────────────────────────────────────────────────────────

CREATE TABLE billing_plans (
  id                       TEXT PRIMARY KEY,                 -- e.g. 'free', 'starter', 'pro', 'scale'
  name                     TEXT NOT NULL,
  description              TEXT,
  monthly_price_cents      INTEGER NOT NULL DEFAULT 0,       -- $-cents charged via Stripe sub
  included_minutes         INTEGER NOT NULL DEFAULT 0,        -- monthly audio-minute allowance
  overage_markup_pct       NUMERIC(6,2),                      -- override org's default markup for overage; NULL = use org default
  stripe_price_id          TEXT UNIQUE,                       -- Stripe Price for the recurring sub
  active                   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order               INTEGER NOT NULL DEFAULT 100,
  features                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plans_public_read" ON billing_plans
  FOR SELECT TO authenticated
  USING (active = TRUE);

-- ── Org subscriptions (one active row per org) ───────────────────────────────

CREATE TABLE org_subscriptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id                  TEXT NOT NULL REFERENCES billing_plans(id),
  stripe_subscription_id   TEXT UNIQUE,
  status                   TEXT NOT NULL DEFAULT 'active'    -- active | trialing | past_due | canceled | incomplete
                             CHECK (status IN ('active','trialing','past_due','canceled','incomplete','paused')),
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  period_minutes_used      NUMERIC(12,3) NOT NULL DEFAULT 0,  -- resets each invoice.payment_succeeded
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_org_active_subscription
  ON org_subscriptions(org_id) WHERE status IN ('active','trialing','past_due');

ALTER TABLE org_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "subs_member_read" ON org_subscriptions
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.user_org_ids()));

-- ── Org credit wallet ────────────────────────────────────────────────────────
-- One row per org. Balance is the source of truth; audit trail lives in the
-- ledger. `balance_micro_usd` BIGINT supports up to ±$9.2T. Non-negative
-- enforced in the RPCs, not the column, because refunds/adjustments may legitimately
-- push it momentarily through zero.

CREATE TABLE org_credits (
  org_id              UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  balance_micro_usd   BIGINT NOT NULL DEFAULT 0,
  lifetime_topup_micro_usd BIGINT NOT NULL DEFAULT 0,
  lifetime_used_micro_usd  BIGINT NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE org_credits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "credits_member_read" ON org_credits
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.user_org_ids()));

-- ── Credit ledger (immutable audit trail) ───────────────────────────────────

CREATE TABLE org_credit_ledger (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  delta_micro_usd BIGINT NOT NULL,                          -- +ve = credit added, -ve = consumed
  reason          TEXT NOT NULL CHECK (reason IN (
                    'topup', 'transcription', 'subscription_grant',
                    'refund', 'adjustment', 'free_grant', 'overage'
                  )),
  description     TEXT,
  -- Idempotency: Stripe events arrive multiple times; webhook UPSERTs on stripe_event_id
  stripe_event_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_invoice_id        TEXT,
  transcription_id UUID,                                    -- nullable FK; resolved later
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_org_time   ON org_credit_ledger(org_id, created_at DESC);
CREATE INDEX idx_ledger_reason     ON org_credit_ledger(reason);
CREATE INDEX idx_ledger_invoice    ON org_credit_ledger(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;

ALTER TABLE org_credit_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ledger_member_read" ON org_credit_ledger
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.user_org_ids()));

-- ── Provider pricing book (raw provider cost — used to compute markup) ──────
-- Versioned by effective_from / effective_until so retroactive cost recalcs work.

CREATE TABLE provider_pricing (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         TEXT NOT NULL,                  -- 'gemini' | 'gemini-vertex' | 'mendel' | 'whisper-runpod' | 'stable-ts' | 'ivrit'
  model_id         TEXT,                           -- e.g. 'gemini-2.5-flash', 'whisper-large-v3', RunPod endpoint id
  unit_type        TEXT NOT NULL CHECK (unit_type IN (
                     'per_input_token', 'per_output_token', 'per_audio_token',
                     'per_audio_minute', 'per_audio_second', 'per_pod_second',
                     'per_request', 'flat'
                   )),
  unit_cost_micro_usd BIGINT NOT NULL,             -- cost per 1 unit, in micro-USD
  notes            TEXT,
  effective_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_until  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pricing_lookup
  ON provider_pricing(provider, model_id, unit_type, effective_from DESC);

ALTER TABLE provider_pricing ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pricing_authenticated_read" ON provider_pricing
  FOR SELECT TO authenticated
  USING (TRUE);

-- ── Transcription usage (one row per transcription request) ─────────────────

CREATE TABLE transcription_usage (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  audio_id            UUID,                                -- optional FK to audio_files (nullable for ad-hoc API uploads)
  provider            TEXT NOT NULL,                       -- 'gemini' | 'gemini-vertex' | 'mendel' | 'whisper-runpod' | 'stable-ts' | 'ivrit'
  model_id            TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'      -- pending | completed | failed | refunded
                       CHECK (status IN ('pending','completed','failed','refunded')),
  audio_seconds       NUMERIC(12,3),                       -- audio duration (seconds)
  -- Provider-specific usage units; NULL when not applicable
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  audio_tokens        INTEGER,
  pod_seconds         NUMERIC(12,3),                       -- RunPod billable execute time
  request_count       INTEGER NOT NULL DEFAULT 1,
  -- Cost calc
  raw_cost_micro_usd      BIGINT NOT NULL DEFAULT 0,
  markup_pct              NUMERIC(6,2) NOT NULL DEFAULT 0,
  charged_cost_micro_usd  BIGINT NOT NULL DEFAULT 0,        -- raw + markup; what we deduct from credits
  charged_to              TEXT NOT NULL DEFAULT 'credits'   -- 'credits' | 'subscription' | 'free_grant'
                          CHECK (charged_to IN ('credits','subscription','free_grant')),
  ledger_id               BIGINT REFERENCES org_credit_ledger(id),
  pricing_snapshot        JSONB NOT NULL DEFAULT '{}'::jsonb, -- capture rates used at time of charge
  error_message           TEXT,
  started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_org_time     ON transcription_usage(org_id, created_at DESC);
CREATE INDEX idx_usage_status       ON transcription_usage(status);
CREATE INDEX idx_usage_provider     ON transcription_usage(provider);

ALTER TABLE transcription_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "usage_member_read" ON transcription_usage
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.user_org_ids()));

-- ── Topup packs (prepaid credit packages shown in checkout UI) ──────────────

CREATE TABLE topup_packs (
  id                  TEXT PRIMARY KEY,            -- 'pack-5', 'pack-25', 'pack-100'
  name                TEXT NOT NULL,
  price_cents         INTEGER NOT NULL,             -- price in USD cents (Stripe-friendly)
  credit_micro_usd    BIGINT NOT NULL,              -- credits delivered (may exceed price for "bonus" packs)
  stripe_price_id     TEXT UNIQUE,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order          INTEGER NOT NULL DEFAULT 100,
  highlight           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE topup_packs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "topups_public_read" ON topup_packs
  FOR SELECT TO authenticated
  USING (active = TRUE);

-- ── Auto-create a personal org for every new auth user ──────────────────────

CREATE OR REPLACE FUNCTION public.ensure_personal_org_for_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_org_id UUID;
  v_email  TEXT;
  v_name   TEXT;
BEGIN
  v_email := NEW.email;
  v_name  := COALESCE(split_part(v_email, '@', 1), 'My Workspace');

  INSERT INTO organizations (name, owner_user_id, is_personal)
  VALUES (v_name || '''s Workspace', NEW.id, TRUE)
  RETURNING id INTO v_org_id;

  INSERT INTO org_members (org_id, user_id, role)
  VALUES (v_org_id, NEW.id, 'owner');

  -- Initialize wallet with welcome credits (configurable via app_settings later)
  INSERT INTO org_credits (org_id, balance_micro_usd, lifetime_topup_micro_usd)
  VALUES (v_org_id, 50000, 50000);  -- $0.05 free credit

  INSERT INTO org_credit_ledger (org_id, delta_micro_usd, reason, description)
  VALUES (v_org_id, 50000, 'free_grant', 'Welcome bonus');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_org ON auth.users;
CREATE TRIGGER on_auth_user_created_org
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_personal_org_for_user();

-- Backfill personal orgs for existing users that don't yet have one.
INSERT INTO organizations (name, owner_user_id, is_personal)
SELECT
  COALESCE(split_part(u.email, '@', 1), 'My Workspace') || '''s Workspace',
  u.id,
  TRUE
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM org_members om WHERE om.user_id = u.id
);

INSERT INTO org_members (org_id, user_id, role)
SELECT o.id, o.owner_user_id, 'owner'
FROM organizations o
LEFT JOIN org_members om ON om.org_id = o.id AND om.user_id = o.owner_user_id
WHERE om.user_id IS NULL;

INSERT INTO org_credits (org_id, balance_micro_usd, lifetime_topup_micro_usd)
SELECT o.id, 50000, 50000
FROM organizations o
LEFT JOIN org_credits c ON c.org_id = o.id
WHERE c.org_id IS NULL;

INSERT INTO org_credit_ledger (org_id, delta_micro_usd, reason, description)
SELECT o.id, 50000, 'free_grant', 'Welcome bonus (backfill)'
FROM organizations o
LEFT JOIN org_credit_ledger l ON l.org_id = o.id AND l.reason = 'free_grant'
WHERE l.id IS NULL;

-- ── Seed default plans + topup packs (Stripe IDs filled in later) ───────────

INSERT INTO billing_plans (id, name, description, monthly_price_cents, included_minutes, overage_markup_pct, sort_order, features) VALUES
  ('free',    'Free',    'Try the platform — 30 minutes/month', 0,    30,   40.00, 1, '{"max_file_minutes": 60}'::jsonb),
  ('starter', 'Starter', '5 hours of transcription per month',  900,  300,  35.00, 2, '{"max_file_minutes": 240, "priority": "standard"}'::jsonb),
  ('pro',     'Pro',     '20 hours/month + lower overage rate', 2900, 1200, 25.00, 3, '{"max_file_minutes": 480, "priority": "high"}'::jsonb),
  ('scale',   'Scale',   '60 hours/month + dedicated support',  7900, 3600, 15.00, 4, '{"max_file_minutes": 1440, "priority": "high", "support": "dedicated"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO topup_packs (id, name, price_cents, credit_micro_usd, sort_order, highlight) VALUES
  ('pack-5',   '$5 Credit Pack',   500,   5000000,   1, FALSE),
  ('pack-25',  '$25 Credit Pack',  2500,  27500000,  2, TRUE),   -- 10% bonus
  ('pack-100', '$100 Credit Pack', 10000, 115000000, 3, FALSE)   -- 15% bonus
ON CONFLICT (id) DO NOTHING;

-- ── Seed initial provider pricing (April 2026 retail rates; edit as needed) ──
-- Pricing is in micro-USD per unit. Update via SQL when provider rates change.

INSERT INTO provider_pricing (provider, model_id, unit_type, unit_cost_micro_usd, notes) VALUES
  -- Gemini 2.5 Flash via API key (per Google AI Studio Sept 2025 rates)
  ('gemini', 'gemini-2.5-flash', 'per_input_token',   3,   'Audio billed at input-token rate; ~32 tok/sec audio'),
  ('gemini', 'gemini-2.5-flash', 'per_audio_token',   1,   'Native audio token (cheaper than text input)'),
  ('gemini', 'gemini-2.5-flash', 'per_output_token',  25,  'Decoded text tokens'),
  -- Gemini 1.5 Pro fallback
  ('gemini', 'gemini-1.5-pro',   'per_input_token',   125,  NULL),
  ('gemini', 'gemini-1.5-pro',   'per_output_token',  500,  NULL),
  -- Vertex AI tuned model — falls back to flash rate
  ('gemini-vertex', NULL, 'per_input_token',  3, 'Tuned model billed at base flash rate per Vertex'),
  ('gemini-vertex', NULL, 'per_output_token', 25, NULL),
  -- Mendel (yiddishlabs) — pass-through pricing approximation
  ('mendel', NULL, 'per_audio_minute', 80000, '~$0.08/min retail; verify with provider invoice'),
  -- RunPod serverless Whisper / stable-ts — billed by pod execution seconds
  ('whisper-runpod', NULL, 'per_pod_second',  280, 'Approx A40 at $1.00/hr; tune per endpoint'),
  ('stable-ts',      NULL, 'per_pod_second',  280, NULL),
  ('ivrit',          NULL, 'per_pod_second',  280, NULL);

-- ── updated_at trigger ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bump_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS bump_orgs ON organizations;
CREATE TRIGGER bump_orgs
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION public.bump_updated_at();

DROP TRIGGER IF EXISTS bump_subs ON org_subscriptions;
CREATE TRIGGER bump_subs
  BEFORE UPDATE ON org_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.bump_updated_at();

DROP TRIGGER IF EXISTS bump_credits ON org_credits;
CREATE TRIGGER bump_credits
  BEFORE UPDATE ON org_credits
  FOR EACH ROW EXECUTE FUNCTION public.bump_updated_at();

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT ON billing_plans, topup_packs, provider_pricing TO authenticated;
GRANT SELECT ON organizations, org_members, org_subscriptions, org_credits, org_credit_ledger, transcription_usage TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_org_ids() TO authenticated;

GRANT ALL ON
  organizations, org_members, billing_plans, org_subscriptions,
  org_credits, org_credit_ledger, provider_pricing, transcription_usage,
  topup_packs
TO service_role;
