# Billing & Multi-Tenant Research

> Research compiled April 2026 for the JEM ASR end-user billing system.
> Goal: meter actual transcription cost per user across **Gemini (token-based)**,
> **RunPod Whisper / stable-ts / ivrit-iterative (pod-second-based)**, and
> **Mendel / yiddishlabs (per-minute)** providers, apply a configurable markup,
> and run a Stripe-powered prepaid-credit + monthly-subscription flow.

---

## TL;DR

**Build it on Supabase + Stripe directly** (the path implemented in this branch).
The off-the-shelf platforms are great but every one of them has gaps for our
weird mix of unit types — particularly RunPod pod-seconds. A 350-line custom
metering layer wins on:

| | Custom (this branch) | Stripe Token Billing | Lago | OpenMeter | Flexprice |
|---|---|---|---|---|---|
| Gemini token markup | ✅ native | ✅ purpose-built | ✅ via meter | ✅ via meter | ✅ |
| RunPod **pod-second** cost | ✅ native | ❌ token-only | ⚠ via meter | ⚠ via meter | ⚠ |
| Mendel per-minute | ✅ native | ⚠ workaround | ✅ | ✅ | ✅ |
| Prepaid credit wallet UI | ✅ built | ❌ no wallet | ✅ built-in | ⚠ DIY | ✅ |
| Monthly sub w/ allowance | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hosted vs self-host | Supabase (hosted) | hosted | both | both | both |
| Vendor lock-in | low | high | low | low | low |
| Time-to-MVP | ~1 day | ~half day | 2-3 days | 2-3 days | 2-3 days |

---

## Option detail

### A. Stripe **Token Billing** (`docs.stripe.com/billing/token-billing`)
- Released GA March 2026 alongside the AI billing push.
- **Auto-syncs LLM provider price catalogs** (OpenAI, Anthropic, Gemini) so you
  don't maintain unit_cost_micro_usd rows. Pretty magical for pure LLM apps.
- Lets you set a **markup percentage** per model and bills on Stripe usage records.
- Customers see line items like *"Gemini 2.5 Flash · 124,000 tokens · $0.32"* on
  invoices.
- ❌ **Can't model RunPod pod-seconds** — there's no "per-pod-second" preset and
  the pricing book is closed-source. You'd end up doing custom meter events for
  RunPod anyway, which removes the main reason to use Token Billing.
- ❌ **No prepaid credit wallet** — Stripe Token Billing is postpaid-metered only.
  You can layer Stripe's separate "credit grants" feature, but that's effectively
  building the wallet yourself.

**Verdict**: would have been the easy answer if we were 100% LLM. We're not.

### B. **Lago** (`getlago.com`, OSS, MIT license)
- Battle-tested OSS billing engine. Used by Mistral, You.com, Cursor.
- **Wallet** entity is a first-class object → matches yiddishlabs UX naturally.
- Define unlimited custom **metrics** (token, audio_minute, pod_second) and
  attach pricing in YAML. Webhooks back to your app on charge events.
- Self-host via Docker or use Lago Cloud (free tier covers our volume).
- ⚠ Adds another moving piece — Lago Postgres + Redis + workers in addition to
  Supabase. Operationally non-trivial.
- ⚠ Lago is the source of truth for invoices / wallet, so we'd need to mirror
  the wallet balance into Supabase or call Lago on every transcription preflight,
  adding latency to a path that already hits CF Workers + Supabase.

**Verdict**: best fit for a B2B-heavy roadmap with complex pricing experiments.
Overkill for our current need.

### C. **OpenMeter** (`openmeter.io`, OSS, Apache 2.0)
- Pure metering — events in, aggregations out. Pairs with Stripe Billing for
  invoicing. Great if we want to keep Stripe for charges and OpenMeter for
  sums/quotas.
- Lighter than Lago, but no built-in wallet UI.
- Same architectural concerns: extra service + duplicated state.

**Verdict**: too narrow alone, redundant with what we already have via SQL aggs.

### D. **Flexprice** (`flexprice.io`, OSS, fast-moving)
- The newest entrant; their blog is the easiest read on the space (much of the
  research above came from their comparison posts).
- Native AI/LLM positioning, includes wallet semantics.
- Smaller community than Lago — production track record is shorter.

**Verdict**: worth re-evaluating in 6 months when growth flattens.

### E. **Custom on Supabase + Stripe** (chosen)
- Single Postgres database we already operate; RLS gives us tenancy for free.
- Postgres `provider_pricing` table = our own price catalog. Update via a
  one-line `INSERT` when Google or RunPod changes rates.
- Cloudflare Worker functions integrate the metering hooks directly into the
  existing `/api/transcribe` and `/api/align` workers we already maintain.
- Stripe handles the actual money: Checkout for topups + subscriptions, Customer
  Portal for self-serve invoice / cancel / payment-method.
- Total surface area added: ~700 lines SQL + ~900 lines JS.

---

## Implemented architecture

### Tenancy

```
auth.users  ──(trigger on insert)──▶  organizations  ◀──many──  org_members
                                          │
                                          ├── org_credits (wallet, BIGINT μ-USD)
                                          ├── org_subscriptions
                                          └── org_credit_ledger (immutable audit)
```

- Every signup creates a **personal org** automatically (`is_personal=true`).
- Users may also be members of **shared orgs** (B2B teams). Billing rolls up to
  the org owner — when an admin uploads audio inside a shared org, it bills the
  org wallet, not the admin's personal one.
- The legacy `library_members` model (internal staff teams) coexists; they live
  in the `libraries` table and remain RLS-scoped exactly as before.

### Cost calculation

`provider_pricing` is the source of truth. Each row binds:

```
(provider, model_id_nullable, unit_type) → unit_cost_micro_usd
```

Where `unit_type ∈ { per_input_token, per_output_token, per_audio_token,
per_audio_second, per_audio_minute, per_pod_second, per_request, flat }`.

When a transcription completes, `computeRawCost()` looks up every applicable
unit type and sums them:

```js
const units = {
  provider: 'gemini',
  model_id: 'gemini-2.5-flash',
  input_tokens: 4_812,    // from Gemini's usageMetadata
  output_tokens: 920,
  audio_seconds: 184.5,
}
// → raw_cost_micro_usd = 4812*3 + 920*25 + 184.5*0 (no per-second rate)
//                      = 14_436 + 23_000 = 37_436 μ-USD ≈ $0.0374
```

`applyMarkup()` then multiplies by `(1 + org.default_markup_pct / 100)`:

```js
charged = raw * (1 + 30/100) = 37_436 * 1.30 ≈ 48_667 μ-USD ≈ $0.0487
```

The markup % is per-org so VIPs / partners can get lower rates and abusive
customers can be flagged with higher ones.

### RunPod pricing (the tricky one)

RunPod returns `executionTime` (ms) on every async job status. We extract that
in `align.js → extractPodSeconds()` and pass it as `pod_seconds` to the meter.
Provider pricing rows hold the per-second rate per endpoint:

```sql
INSERT INTO provider_pricing
  (provider,         model_id, unit_type,       unit_cost_micro_usd, notes)
VALUES
  ('whisper-runpod', NULL,     'per_pod_second', 280, 'A40 @ $1/hr');
  --                                              ^^^
  --   $0.000280 per second  =  $1.008 per hour billed by RunPod
```

Updating one row when you switch from A40 to L40S (or RunPod changes prices)
re-prices every future transcription. Historical transcriptions keep their
`pricing_snapshot` JSONB — we never retroactively bill anyone.

### Subscription + credits hybrid

A user with an active subscription gets `included_minutes` per period. The
preflight RPC checks remaining allowance first (`charge_to='subscription'`);
if the file would push them over, we fall back to the credit wallet
(`charge_to='credits'`). Renewals reset `period_minutes_used` to zero on
`invoice.payment_succeeded`.

### Stripe integration

| Event | Webhook handler | Effect |
|---|---|---|
| `checkout.session.completed` (purpose=topup) | `add_org_credits` RPC | Credit ledger += pack value |
| `checkout.session.completed` (purpose=subscribe) | links Stripe customer → org | Subscription created next event |
| `customer.subscription.created` / `updated` | `upsert_org_subscription` | Status, dates, cancel flag |
| `invoice.payment_succeeded` | `upsert_org_subscription` (renewal) | Resets `period_minutes_used` |
| `customer.subscription.deleted` | sets status='canceled' | Org falls back to credit-only |

Idempotency: `org_credit_ledger.stripe_event_id` has a UNIQUE constraint and
`add_org_credits` no-ops on conflict, so Stripe webhook retries are safe.

### Security

- **All** credit mutations go through `SECURITY DEFINER` RPCs that re-verify
  the caller's org membership. Service-role-only RPCs (`charge_transcription`,
  `add_org_credits`) cannot be called from the browser.
- RLS policies on every table use `public.user_org_ids()` so a customer can
  read their own data and nothing else.
- The `/api/transcribe` and `/api/align` workers verify the caller's Supabase
  JWT via `getCallerUser()` before metering.

---

## Required Stripe / env config

Set these as Cloudflare Pages **secrets** (not env vars):

```
STRIPE_SECRET_KEY          sk_live_…   used by topup / subscribe / portal endpoints
STRIPE_WEBHOOK_SECRET      whsec_…     verifies /api/stripe-webhook signatures
SUPABASE_URL               https://xxxx.supabase.co
SUPABASE_SERVICE_KEY       service-role JWT
SUPABASE_ANON_KEY          anon JWT (for verifying user JWTs)
```

For each plan in `billing_plans` you must:

1. Create a **Stripe Product** ("JEM ASR — Pro") and a recurring **Price**
   (`$29/mo`).
2. Update the row: `UPDATE billing_plans SET stripe_price_id='price_xxx' WHERE id='pro'`.
3. Create the webhook endpoint pointing at `https://<your-domain>/api/stripe-webhook`
   subscribed to the events listed above.

For each `topup_packs` row, no Stripe Product is needed — we use Stripe's
inline `price_data` so packs can be edited freely in the DB.

---

## Open questions / next iterations

1. **Tax** — Stripe Tax should be enabled on the account so Checkout Sessions
   collect VAT/GST. No code change needed; toggle in Stripe Dashboard.
2. **Refund policy** — `refund_transcription` RPC exists and can be wired into
   an admin button. Decide if we auto-refund on alignment failures.
3. **Multi-tier markup** — `billing_plans.overage_markup_pct` already supports
   per-plan markup overrides; `applyMarkup` could read from the active sub
   instead of the org's default.
4. **Cost alerts** — add a Cloudflare cron that posts to Slack when
   `lifetime_used_micro_usd > 80% lifetime_topup_micro_usd` for any org.
5. **Promo codes** — Stripe Coupons → Checkout natively. Add a small endpoint
   to create one-time credit grants for partners (just an `add_org_credits`
   call with `reason='free_grant'`).

---

## Appendix: file map (this worktree)

```
supabase/migrations/
  20260428000000_end_user_billing.sql   schema (orgs, plans, credits, ledger, usage, pricing)
  20260428000001_billing_rpcs.sql       atomic credit / charge / refund RPCs
functions/api/
  billing/_lib.js          shared cost calculator + auth + Stripe helpers
  billing/summary.js       GET balance + sub + 30-day usage (single round-trip)
  billing/plans.js         GET active plans + topup packs
  billing/usage.js         GET recent usage + ledger (last N days)
  billing/topup.js         POST → Stripe Checkout for a credit pack
  billing/subscribe.js     POST → Stripe Checkout for a subscription
  billing/portal.js        POST → Stripe Customer Portal session
  stripe-webhook.js        REWRITTEN: handles topups, subs, renewals, plus legacy WA flow
  transcribe.js            wired with preflight → finalizeUsage (gemini / mendel)
  align.js                 wired with pod-second metering (runpod / stable-ts / ivrit)
billing.html, src/billing.js     wallet UI: balance, sub meter, topup, plan grid, usage table
signup.html, src/signup.js       end-user signup (auto-creates personal org via trigger)
```
