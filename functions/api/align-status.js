// GET /api/align-status?job_id=<id>&endpoint_label=<stable-ts|ivrit-iterative>
//                     [&usage_id=<uuid>]
//
// Client-driven polling for long RunPod transcribe jobs. Each call hits
// RunPod's /status/{id} once. When the job is COMPLETED we finalize the
// usage row that was created at kickoff, returning the transcript text.
//
// Mirrors the response shape used by /api/transcribe-status:
//   { status:'processing', job_id }
//   { status:'completed',  text, usage_id, audio_seconds }
//   { status:'failed',     error, usage_id }

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

function endpointFromLabel(env, label) {
  switch (label) {
    case 'stable-ts':       return env?.STABLE_TS_ENDPOINT_ID;
    case 'stable-ts-trim':  return env?.STABLE_TS_TRIM_ENDPOINT_ID;
    case 'ivrit-iterative': return env?.IVRIT_ENDPOINT_ID;
    default: return null;
  }
}

function extractText(out) {
  if (!out || typeof out !== 'object') return null;
  const candidates = [out.text, out.full_text, out.transcription];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

function extractPodSeconds(status) {
  const ms = status?.executionTime
    ?? status?.execution_time
    ?? status?.workerStats?.executionTime
    ?? null;
  if (ms == null) return null;
  return ms / 1000;
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const jobId = url.searchParams.get('job_id');
    const label = url.searchParams.get('endpoint_label') || 'stable-ts';
    const usageId = url.searchParams.get('usage_id') || null;
    const audioSecondsHint = Number(url.searchParams.get('audio_seconds') || 0) || null;

    if (!jobId) return json({ error: 'Missing job_id' }, 400);
    const env = context.env;
    const endpointId = endpointFromLabel(env, label);
    const apiKey = env?.RUNPOD_API_KEY;
    if (!endpointId || !apiKey) {
      return json({ error: `Endpoint not configured for label=${label}` }, 500);
    }

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

    const statusResp = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!statusResp.ok) {
      const body = await statusResp.text().catch(() => '');
      console.error('[align-status] runpod status failed', { httpStatus: statusResp.status, body: body.slice(0, 500) });
      return json({ error: `RunPod status ${statusResp.status}`, detail: body.slice(0, 500) }, 502);
    }
    const status = await statusResp.json();
    const s = String(status?.status || '').toUpperCase();

    if (s === 'FAILED' || s === 'CANCELLED') {
      const errMsg = status?.error || `RunPod job ${s}`;
      if (billing && usageId) {
        await failUsage(env, usageId, typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg).slice(0, 500))
          .catch(e => console.error('[align-status] failUsage:', e));
      }
      return json({ status: 'failed', error: typeof errMsg === 'string' ? errMsg : 'job failed', usage_id: usageId || undefined });
    }

    if (s === 'COMPLETED') {
      const out = status?.output || {};
      const text = extractText(out);
      const podSeconds = extractPodSeconds(status);
      const audioSeconds = out?.audio_duration ?? out?.duration ?? audioSecondsHint;

      if (billing && usageId) {
        const pre = await preflight(env, billing.orgId, audioSeconds || 0).catch(() => null);
        const chargeTo = pre?.charge_to || 'wallet';
        await finalizeUsage(env, {
          orgId: billing.orgId,
          usageId,
          providerUsage: {
            provider: label === 'ivrit-iterative' ? 'ivrit' : 'stable-ts',
            model_id: label,
            audio_seconds: audioSeconds,
            pod_seconds: podSeconds,
            request_count: 1,
          },
          markupPct: billing.markupPct,
          chargeTo,
        }).catch(err => console.error('[align-status] finalize failed:', err));
      }
      return json({
        status: 'completed',
        text,
        // Pass through the full pod output too — older alignment.js consumers
        // expect segment-level data on align (non-transcribe) mode.
        output: out,
        usage_id: usageId || undefined,
        audio_seconds: audioSeconds,
        pod_seconds: podSeconds,
      });
    }

    return json({ status: 'processing', job_id: jobId, runpod_status: s.toLowerCase() });
  } catch (err) {
    console.error('[align-status] fail', { message: err?.message, stack: err?.stack });
    const status = typeof err?.status === 'number' ? err.status : 500;
    return json({ error: err?.message || 'align-status failed' }, status);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
