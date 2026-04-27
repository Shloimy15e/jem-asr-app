/**
 * Shared billing helpers for Cloudflare Pages Functions.
 *
 *   ┌──────────────────────────┐
 *   │   /api/transcribe (etc.) │
 *   └────────────┬─────────────┘
 *                │ getCallerOrg → preflight → run provider → finalizeUsage
 *                ▼
 *      ┌────────────────────┐         ┌──────────────────────┐
 *      │  Supabase RPCs     │ ────────│ org_credits + ledger │
 *      └────────────────────┘         └──────────────────────┘
 *
 * All money is micro-USD (1_000_000 = $1).
 */

export const MICRO = 1_000_000n; // micro-USD per dollar

// ─── Auth (caller → user_id + org_id) ──────────────────────────────────────

/**
 * Resolve the calling Supabase user from the Authorization header. Returns
 * {userId, accessToken} or throws {status, message}.
 */
export async function getCallerUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw { status: 401, message: 'Missing bearer token' };
  const accessToken = match[1];

  const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!resp.ok) throw { status: 401, message: 'Invalid session' };
  const user = await resp.json();
  if (!user?.id) throw { status: 401, message: 'Invalid session' };
  return { userId: user.id, email: user.email, accessToken };
}

/**
 * Resolve the org for a caller — uses optional `org_id` from payload, otherwise
 * defaults to the user's personal org. Returns the org_id (UUID).
 */
export async function getCallerOrg(env, accessToken, requestedOrgId = null) {
  const result = await sbRpc(env, 'resolve_billing_org', { p_org_id: requestedOrgId }, { accessToken });
  if (typeof result !== 'string') {
    throw { status: 500, message: 'Failed to resolve org' };
  }
  return result;
}

// ─── Supabase REST + RPC helpers ───────────────────────────────────────────

export async function sbFetch(env, path, opts = {}) {
  const useService = !opts.accessToken;
  const headers = {
    apikey: useService ? env.SUPABASE_SERVICE_KEY : (env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_KEY),
    Authorization: `Bearer ${opts.accessToken || env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw { status: res.status, message: `Supabase ${path}: ${res.status} ${text.slice(0, 300)}` };
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

export async function sbRpc(env, fn, args, opts = {}) {
  return sbFetch(env, `rpc/${fn}`, {
    method: 'POST',
    body: JSON.stringify(args || {}),
    accessToken: opts.accessToken,
  });
}

// ─── Cost calculator ───────────────────────────────────────────────────────
//
// Each provider exposes different billable signals:
//   • gemini   — input/output/audio tokens
//   • mendel   — flat per-minute rate
//   • runpod   — pod execution seconds (workerStats from RunPod payload)
//
// We look up `provider_pricing` for each unit type, multiply, then layer on
// the org's markup_pct. Result is split into raw_cost / charged_cost.

/**
 * Look up the pricing snapshot active right now for a (provider, model_id, unit_type).
 * Returns the row or null.
 */
async function fetchPricing(env, provider, modelId, unitType) {
  // Prefer specific model_id match; fall back to NULL model_id (provider-wide).
  const params = new URLSearchParams({
    select: '*',
    provider: `eq.${provider}`,
    unit_type: `eq.${unitType}`,
    effective_from: `lte.${new Date().toISOString()}`,
    order: 'effective_from.desc',
    limit: '5',
  });
  const rows = await sbFetch(env, `provider_pricing?${params}`).catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // Filter unexpired
  const live = rows.filter(r => !r.effective_until || new Date(r.effective_until) > new Date());
  if (live.length === 0) return null;
  // Prefer model match
  const exact = live.find(r => r.model_id === modelId);
  return exact || live.find(r => r.model_id === null) || live[0];
}

/**
 * Compute raw cost (in micro-USD) for a given provider/usage record.
 *
 * usage:  { provider, model_id, audio_seconds, input_tokens, output_tokens,
 *           audio_tokens, pod_seconds, request_count }
 * Returns: { raw_cost_micro_usd: BigInt, breakdown: [{unit_type, units, rate_micro, subtotal_micro}] }
 */
export async function computeRawCost(env, usage) {
  const breakdown = [];
  let total = 0n;

  async function add(unitType, units) {
    if (units == null || units <= 0) return;
    const row = await fetchPricing(env, usage.provider, usage.model_id || null, unitType);
    if (!row) return;
    const rate = BigInt(row.unit_cost_micro_usd);
    const u = BigInt(Math.ceil(Number(units)));
    const subtotal = rate * u;
    total += subtotal;
    breakdown.push({
      unit_type: unitType,
      units: Number(units),
      rate_micro_usd: Number(row.unit_cost_micro_usd),
      subtotal_micro_usd: Number(subtotal),
    });
  }

  await add('per_input_token', usage.input_tokens);
  await add('per_output_token', usage.output_tokens);
  await add('per_audio_token', usage.audio_tokens);
  await add('per_audio_minute', usage.audio_seconds ? usage.audio_seconds / 60 : null);
  await add('per_audio_second', usage.audio_seconds);
  await add('per_pod_second', usage.pod_seconds);
  await add('per_request', usage.request_count || 1);

  return { raw_cost_micro_usd: total, breakdown };
}

/** Apply markup_pct to a raw cost. Returns a BigInt. */
export function applyMarkup(rawMicro, markupPct) {
  const pct = Number(markupPct || 0);
  if (!Number.isFinite(pct) || pct <= 0) return rawMicro;
  // Use bigint math: raw + raw * pct/100
  const num = BigInt(Math.round(pct * 100));      // pct * 100 → integer percent-bps
  const denom = 10000n;
  return rawMicro + (rawMicro * num) / denom;
}

// ─── Usage row lifecycle ───────────────────────────────────────────────────

/**
 * Pre-flight: confirm the org can run a transcription. Returns:
 *   { allowed, charge_to, plan_id, balance_micro_usd, plan_remaining_minutes }
 */
export async function preflight(env, orgId, audioSeconds) {
  return sbRpc(env, 'preflight_transcription', {
    p_org_id: orgId,
    p_audio_seconds: audioSeconds || 0,
  });
}

/**
 * Insert a pending transcription_usage row up-front, before calling the provider.
 * Returns the new row's id (UUID). The worker MUST finalize it later.
 */
export async function startUsage(env, { orgId, userId, audioId, provider, modelId, audioSeconds }) {
  const rows = await sbFetch(env, 'transcription_usage', {
    method: 'POST',
    body: JSON.stringify({
      org_id: orgId,
      user_id: userId,
      audio_id: audioId || null,
      provider,
      model_id: modelId || null,
      status: 'pending',
      audio_seconds: audioSeconds || null,
    }),
    headers: { Prefer: 'return=representation' },
  });
  return rows[0]?.id;
}

/**
 * Finalize a usage row after the provider returns. Computes raw cost, applies
 * markup, calls charge_transcription, marks the row completed.
 *
 * ctx: { orgId, usageId, providerUsage, markupPct, chargeTo }
 *   providerUsage: see computeRawCost shape (provider, model_id, audio_seconds, …)
 */
export async function finalizeUsage(env, ctx) {
  const { raw_cost_micro_usd, breakdown } = await computeRawCost(env, ctx.providerUsage);
  const charged = applyMarkup(raw_cost_micro_usd, ctx.markupPct);

  // Update the row with the cost details.
  await sbFetch(env, `transcription_usage?id=eq.${ctx.usageId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'completed',
      input_tokens:  ctx.providerUsage.input_tokens || null,
      output_tokens: ctx.providerUsage.output_tokens || null,
      audio_tokens:  ctx.providerUsage.audio_tokens || null,
      pod_seconds:   ctx.providerUsage.pod_seconds || null,
      audio_seconds: ctx.providerUsage.audio_seconds || null,
      raw_cost_micro_usd: Number(raw_cost_micro_usd),
      markup_pct: ctx.markupPct,
      charged_cost_micro_usd: Number(charged),
      charged_to: ctx.chargeTo,
      pricing_snapshot: { breakdown, captured_at: new Date().toISOString() },
      completed_at: new Date().toISOString(),
    }),
  });

  // Apply the charge atomically.
  return sbRpc(env, 'charge_transcription', {
    p_usage_id: ctx.usageId,
    p_charge_to: ctx.chargeTo,
    p_charged_cost_micro_usd: Number(charged),
    p_audio_seconds: ctx.providerUsage.audio_seconds || 0,
  });
}

/** Mark a usage row failed (no charge). */
export async function failUsage(env, usageId, errorMessage) {
  await sbFetch(env, `transcription_usage?id=eq.${usageId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'failed',
      error_message: String(errorMessage || '').slice(0, 1000),
      completed_at: new Date().toISOString(),
    }),
  }).catch(err => console.error('[billing] failUsage:', err));
}

// ─── Stripe helpers ────────────────────────────────────────────────────────

const STRIPE_API = 'https://api.stripe.com/v1';

/**
 * Minimal Stripe REST helper — uses Bearer auth + form encoding (Stripe
 * doesn't accept JSON for most endpoints).
 */
export async function stripeRequest(env, path, { method = 'POST', form = null, query = null } = {}) {
  const url = new URL(`${STRIPE_API}${path}`);
  if (query) {
    Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  }
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2025-09-30.basil',
    },
  };
  if (form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = encodeForm(form);
  }
  const res = await fetch(url.href, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw { status: res.status, message: data?.error?.message || `Stripe ${path}: ${res.status}` };
  }
  return data;
}

// Form encoder that supports nested keys like { 'metadata[org_id]': '…' }
function encodeForm(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => params.append(`${k}[${i}]`, String(item)));
    } else if (typeof v === 'object') {
      for (const [kk, vv] of Object.entries(v)) {
        if (vv != null) params.append(`${k}[${kk}]`, String(vv));
      }
    } else {
      params.append(k, String(v));
    }
  }
  return params.toString();
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

export function errorResponse(status, message, extra = {}) {
  return jsonResponse({ error: message, ...extra }, status);
}

/** Wrap a handler with auth + standard error handling. */
export function withAuth(handler) {
  return async (context) => {
    try {
      const { userId, email, accessToken } = await getCallerUser(context.request, context.env);
      return await handler({ ...context, user: { id: userId, email }, accessToken });
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      const message = err?.message || 'Internal error';
      return errorResponse(status, message);
    }
  };
}
