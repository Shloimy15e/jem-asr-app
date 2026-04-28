// GET /api/transcribe-status?provider=mendel&job_id=<id>&usage_id=<uuid>
//
// Client-driven polling for long Mendel jobs. The Worker forwards a single
// GET to the Mendel API per call (no DB state); when Mendel reports the job
// completed we finalize the usage_id row that was created at kickoff.
//
// Response shapes:
//   { status:'processing', job_id }
//   { status:'completed',  text, usage_id, audio_seconds }
//   { status:'failed',     error,  usage_id }
//
// Auth: required (mirrors /api/transcribe). The bearer token is needed both
// to resolve the org for finalizeUsage and as a generic abuse guard — we
// don't want unauthenticated callers polling arbitrary Mendel job ids.

import {
  getCallerUser, getCallerOrg, preflight, finalizeUsage, failUsage, sbFetch,
} from './billing/_lib.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function fetchMendelJob(env, jobId) {
  const base = (env.YL_ENDPOINT_BASE || 'https://app.yiddishlabs.com/api/v1').replace(/\/+$/, '');
  const resp = await fetch(`${base}/transcriptions/${encodeURIComponent(jobId)}`, {
    headers: { 'X-API-KEY': env.YL_API_KEY },
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const provider = (url.searchParams.get('provider') || 'mendel').toLowerCase();
    const jobId = url.searchParams.get('job_id');
    const usageId = url.searchParams.get('usage_id') || null;

    if (!jobId) return json({ error: 'Missing job_id' }, 400);
    if (provider !== 'mendel') {
      return json({ error: `Unsupported provider for transcribe-status: ${provider}` }, 400);
    }

    const env = context.env;
    if (!env.YL_API_KEY) return json({ error: 'Mendel API key not configured' }, 500);

    // Auth + org for finalizeUsage. We tolerate "no auth" only when there's
    // no usage_id to finalize (internal/test polling); otherwise require it.
    let billing = null;
    const auth = context.request.headers.get('authorization');
    if (auth) {
      const { userId, accessToken } = await getCallerUser(context.request, env);
      const orgId = await getCallerOrg(env, accessToken, null);
      const orgs = await sbFetch(env, `organizations?id=eq.${orgId}&select=default_markup_pct`);
      const markupPct = Number(orgs?.[0]?.default_markup_pct ?? 30);
      billing = { userId, accessToken, orgId, markupPct };
    } else if (usageId) {
      return json({ error: 'Missing bearer token' }, 401);
    }

    const { ok, status: httpStatus, data } = await fetchMendelJob(env, jobId);
    if (!ok) {
      console.error('[transcribe-status] mendel poll failed', { httpStatus, data });
      return json({ error: `Mendel poll failed: ${httpStatus}`, detail: data }, 502);
    }

    const status = String(data?.status || '').toLowerCase();
    const text = typeof data?.text === 'string' ? data.text.trim() : null;
    const audioSeconds = data?.duration_seconds || data?.duration || null;

    if (status === 'failed' || status === 'error') {
      const errMsg = data?.error?.message || data?.error || data?.message || 'Mendel job failed';
      if (billing && usageId) {
        await failUsage(env, usageId, errMsg).catch(e => console.error('[transcribe-status] failUsage:', e));
      }
      return json({ status: 'failed', error: errMsg, usage_id: usageId || undefined }, 200);
    }

    if (status === 'completed' || status === 'done' || (text && text.length > 0)) {
      if (billing && usageId) {
        // We don't have charge_to from preflight here (was set at kickoff but
        // not persisted); re-resolve it via the same RPC path used in
        // transcribe.js. Cheap and avoids a schema change.
        const pre = await preflight(env, billing.orgId, audioSeconds || 0).catch(() => null);
        const chargeTo = pre?.charge_to || 'wallet';
        await finalizeUsage(env, {
          orgId: billing.orgId,
          usageId,
          providerUsage: {
            provider: 'mendel',
            model_id: null,
            audio_seconds: audioSeconds,
            request_count: 1,
          },
          markupPct: billing.markupPct,
          chargeTo,
        }).catch(err => console.error('[transcribe-status] finalize failed:', err));
      }
      return json({
        status: 'completed',
        text,
        usage_id: usageId || undefined,
        audio_seconds: audioSeconds,
      }, 200);
    }

    return json({ status: 'processing', job_id: jobId, audio_seconds: audioSeconds }, 200);
  } catch (err) {
    console.error('[transcribe-status] fail', { message: err?.message, stack: err?.stack });
    const status = typeof err?.status === 'number' ? err.status : 500;
    return json({ error: err?.message || 'transcribe-status failed' }, status);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
