// Proxy alignment requests to avoid CORS issues.
// POST /api/align -> https://align.kohnai.ai/api/align (stable-ts, untrimmed)
//                 -> https://api.runpod.ai/v2/$STABLE_TS_TRIM_ENDPOINT_ID/run (stable-ts, trimmed)
//                 -> https://api.runpod.ai/v2/$IVRIT_ENDPOINT_ID/run (ivrit-iterative)
//
// Forwards audio_url (+ optional trim_start / trim_end) straight to the pod.
// The Worker never touches audio bytes — prevents CF error 1102 on long audio.
//
// Billing integration (April 2026):
//   Authed callers (Bearer token) trigger metering. RunPod returns
//   `executionTime` (ms) in its async status payload — that becomes our
//   pod_seconds. Mode=transcribe drains credits the same way as /api/transcribe.

import {
  getCallerUser, getCallerOrg, preflight, startUsage, finalizeUsage, failUsage,
  sbFetch,
} from './billing/_lib.js';

const ALIGN_ENDPOINT = 'https://align.kohnai.ai/api/align';

// RunPod async /run + polling bounds. 5s intervals × 60 = 5 min total.
// Browser alignment.js retries on 502/504 so terminal long-audio jobs still land.
const RUNPOD_POLL_MAX = 60;
const RUNPOD_POLL_INTERVAL_MS = 5000;

function getAllowedDomains(env) {
  if (env?.ALLOWED_R2_DOMAINS) {
    return env.ALLOWED_R2_DOMAINS.split(',').map(d => d.trim()).filter(Boolean);
  }
  return ['audio.kohnai.ai', 'pub-c3d984b0acf3415ab61d979b1a4d9665.r2.dev'];
}

// Forward an already-validated audio_url request to a RunPod serverless
// endpoint using the async /run + polling protocol. The pod downloads the
// audio itself, so the Worker never touches bytes.
//
//   label       — used in error messages, e.g. "ivrit-iterative" or "stable-ts-trim"
//   endpointId  — RunPod serverless endpoint id
//   apiKey      — RunPod API key (Bearer)
// Pull pod execution seconds out of a RunPod status payload. RunPod returns
// executionTime in ms on completed jobs.
function extractPodSeconds(status) {
  const ms = status?.executionTime
    ?? status?.execution_time
    ?? status?.workerStats?.executionTime
    ?? null;
  if (ms == null) return null;
  return ms / 1000;
}

async function forwardToRunPodAsync(payload, { endpointId, apiKey, label }, corsHeaders) {
  const input = {
    mode: payload.mode || 'align',
    audio_url: payload.audio_url,
    text: payload.text,
    language: payload.language || 'yi',
  };
  if (payload.trim_start != null) input.trim_start = payload.trim_start;
  if (payload.trim_end != null && payload.trim_end > 0) input.trim_end = payload.trim_end;

  const runResp = await fetch(`https://api.runpod.ai/v2/${endpointId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input }),
  });
  if (!runResp.ok) {
    const body = await runResp.text().catch(() => '');
    return new Response(
      JSON.stringify({ error: `${label} /run failed: ${runResp.status}`, detail: body }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }
  const runData = await runResp.json();
  if (!runData.id) {
    return new Response(
      JSON.stringify({ error: `${label} /run did not return job id`, detail: runData }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }

  for (let i = 0; i < RUNPOD_POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, RUNPOD_POLL_INTERVAL_MS));
    const statusResp = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${runData.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!statusResp.ok) continue;
    const status = await statusResp.json();
    if (status.status === 'COMPLETED') {
      const podSeconds = extractPodSeconds(status);
      const out = { ...(status.output || {}) };
      // Surface metering data for the wrapper to consume; harmless to clients.
      if (podSeconds != null) out._pod_seconds = podSeconds;
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    if (status.status === 'FAILED' || status.status === 'CANCELLED') {
      return new Response(
        JSON.stringify({ error: `${label} job ${status.status}`, detail: status.error || status }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }
  }
  return new Response(
    JSON.stringify({ error: `${label} job still running after 5 min — retry to resume polling`, jobId: runData.id }),
    { status: 504, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
  );
}

async function forwardToIvritPod(payload, env, corsHeaders) {
  const endpointId = env?.IVRIT_ENDPOINT_ID;
  const apiKey = env?.RUNPOD_API_KEY;
  if (!endpointId || !apiKey) {
    return new Response(
      JSON.stringify({ error: 'ivrit-iterative not configured: set IVRIT_ENDPOINT_ID and RUNPOD_API_KEY in Pages env' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }
  return forwardToRunPodAsync(payload, { endpointId, apiKey, label: 'ivrit-iterative' }, corsHeaders);
}

async function forwardToStableTsTrimPod(payload, env, corsHeaders) {
  const endpointId = env?.STABLE_TS_TRIM_ENDPOINT_ID;
  const apiKey = env?.RUNPOD_API_KEY;
  if (!endpointId || !apiKey) {
    return new Response(
      JSON.stringify({ error: 'stable-ts-trim not configured: set STABLE_TS_TRIM_ENDPOINT_ID and RUNPOD_API_KEY in Pages env' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }
  return forwardToRunPodAsync(payload, { endpointId, apiKey, label: 'stable-ts-trim' }, corsHeaders);
}

// Default stable-ts pod (no trim). Same image as the trim pod minus ffmpeg
// pre-trim. Async polling -> avoids the synchronous align.kohnai.ai chain
// blowing the 100s CF wall-clock cap on cold starts.
async function forwardToStableTsPod(payload, env, corsHeaders) {
  const endpointId = env?.STABLE_TS_ENDPOINT_ID;
  const apiKey = env?.RUNPOD_API_KEY;
  if (!endpointId || !apiKey) {
    return new Response(
      JSON.stringify({ error: 'stable-ts not configured: set STABLE_TS_ENDPOINT_ID and RUNPOD_API_KEY in Pages env' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }
  return forwardToRunPodAsync(payload, { endpointId, apiKey, label: 'stable-ts' }, corsHeaders);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Resolve optional billing context if the caller is authed.
async function tryResolveBillingContext(request, env, payload) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  const auth = request.headers.get('authorization');
  if (!auth) return null;
  const { userId, accessToken } = await getCallerUser(request, env);
  const orgId = await getCallerOrg(env, accessToken, payload.org_id || null);
  const orgs = await sbFetch(env, `organizations?id=eq.${orgId}&select=default_markup_pct`);
  return {
    userId,
    accessToken,
    orgId,
    markupPct: Number(orgs?.[0]?.default_markup_pct ?? 30),
  };
}

// Wrap any pod response and meter pod_seconds when billing context is present.
async function wrapWithMetering(originalResponse, { env, billing, payload, providerLabel }) {
  if (!billing || !originalResponse.ok) return originalResponse;

  // Read body, extract pod_seconds, then return a clean version to the client.
  let bodyJson = null;
  const cloned = originalResponse.clone();
  try {
    bodyJson = await cloned.json();
  } catch { return originalResponse; }

  const podSeconds = bodyJson?._pod_seconds || null;
  // Audio duration: prefer client-supplied, else fall back to ASR-reported
  const audioSeconds =
    payload.audio_duration_seconds
    ?? bodyJson?.audio_duration
    ?? bodyJson?.duration
    ?? null;

  // Only meter when this was a transcription call (mode='transcribe').
  // Pure alignment calls (cleaned text already supplied) are still recorded
  // but with audio_seconds → so the cost reflects pod time + minutes.
  try {
    const pre = await preflight(env, billing.orgId, audioSeconds || 0);
    if (!pre.allowed) {
      return new Response(
        JSON.stringify({ error: 'Insufficient credits', balance_micro_usd: pre.balance_micro_usd }),
        { status: 402, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
      );
    }
    const usageId = await startUsage(env, {
      orgId: billing.orgId,
      userId: billing.userId,
      audioId: payload.audio_id || null,
      provider: providerLabel,
      modelId: payload.aligner || null,
      audioSeconds,
    });
    await finalizeUsage(env, {
      orgId: billing.orgId,
      usageId,
      providerUsage: {
        provider: providerLabel,
        model_id: payload.aligner || null,
        audio_seconds: audioSeconds,
        pod_seconds: podSeconds,
        request_count: 1,
      },
      markupPct: billing.markupPct,
      chargeTo: pre.charge_to,
    }).catch(err => console.error('[billing] align finalize:', err));
  } catch (err) {
    console.error('[billing] align meter failed:', err);
  }

  // Strip internal _pod_seconds before returning to client.
  delete bodyJson._pod_seconds;
  return new Response(JSON.stringify(bodyJson), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestPost(context) {
  let billing = null;
  try {
    const payload = await context.request.json();
    console.log('[align] req', {
      mode: payload.mode || 'align',
      aligner: payload.aligner || 'stable-ts',
      hasAudioUrl: !!payload.audio_url,
      audioUrlHost: payload.audio_url ? (() => { try { return new URL(payload.audio_url).hostname; } catch { return 'invalid'; } })() : null,
      hasAudioB64: !!payload.audio_base64,
      hasText: !!payload.text,
      audio_id: payload.audio_id || null,
      trim_start: payload.trim_start ?? null,
      trim_end: payload.trim_end ?? null,
      stable_ts_endpoint_set: !!context.env?.STABLE_TS_ENDPOINT_ID,
      stable_ts_trim_endpoint_set: !!context.env?.STABLE_TS_TRIM_ENDPOINT_ID,
      ivrit_endpoint_set: !!context.env?.IVRIT_ENDPOINT_ID,
      runpod_key_set: !!context.env?.RUNPOD_API_KEY,
    });
    billing = await tryResolveBillingContext(context.request, context.env, payload).catch(err => {
      throw err;
    });

    // If the client sent audio_url, forward it to the pod as-is.
    // The pod downloads the audio and (for stable-ts) honours trim_start /
    // trim_end — no bytes ever touch the Worker.
    if (payload.audio_url) {
      // Validate hostname to prevent SSRF — only allow our R2 bucket
      let parsedUrl;
      try {
        parsedUrl = new URL(payload.audio_url);
      } catch {
        return new Response(
          JSON.stringify({ error: 'Invalid audio_url' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
        );
      }
      if (!getAllowedDomains(context.env).includes(parsedUrl.hostname)) {
        return new Response(
          JSON.stringify({ error: 'audio_url domain not in allowed list' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
        );
      }
      if (parsedUrl.protocol !== 'https:') {
        return new Response(
          JSON.stringify({ error: 'audio_url must use https' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
        );
      }

      // ── ivrit-iterative path ─────────────────────────────────────────
      // The new pod downloads the audio itself on its VM, so we skip the
      // base64 rewrite entirely and forward audio_url straight to RunPod.
      if (payload.aligner === 'ivrit-iterative') {
        const resp = await forwardToIvritPod(payload, context.env, CORS_HEADERS);
        return wrapWithMetering(resp, { env: context.env, billing, payload, providerLabel: 'ivrit' });
      }

      // ── stable-ts path ───────────────────────────────────────────────
      // Untrimmed requests go to the original pod at align.kohnai.ai — it
      // honours audio_url and returns the raw pod output directly.
      //
      // Trimmed requests route to the trim-capable pod on RunPod when
      // STABLE_TS_TRIM_ENDPOINT_ID is set. That image pre-trims audio
      // with ffmpeg before alignment (the default pod silently ignores
      // trim_end). When unset, trimmed requests fall back to the default
      // pod — which works for untrimmed-style alignments but will drift
      // on large trim_end gaps until the secret is configured.
      const hasTrim = (payload.trim_start > 0) || (payload.trim_end > 0);
      if (hasTrim && context.env?.STABLE_TS_TRIM_ENDPOINT_ID) {
        const resp = await forwardToStableTsTrimPod(payload, context.env, CORS_HEADERS);
        return wrapWithMetering(resp, { env: context.env, billing, payload, providerLabel: 'stable-ts' });
      }
      // Prefer async polling against the stable-ts pod when configured —
      // avoids the synchronous align.kohnai.ai chain that hits the 100s
      // CF wall-clock cap on cold starts.
      if (context.env?.STABLE_TS_ENDPOINT_ID) {
        const resp = await forwardToStableTsPod(payload, context.env, CORS_HEADERS);
        return wrapWithMetering(resp, { env: context.env, billing, payload, providerLabel: 'stable-ts' });
      }
      // Legacy fallback: synchronous chain via align.kohnai.ai. Kept for
      // backward compatibility when STABLE_TS_ENDPOINT_ID isn't set.
      const forwardPayload = { ...payload };
      delete forwardPayload.audio_duration; // pod doesn't use this
      const resp = await fetch(ALIGN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forwardPayload),
        cf: { cacheTtl: 0 },
      });
      const wrapped = new Response(resp.body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') || 'application/json',
          ...CORS_HEADERS,
        },
      });
      return wrapWithMetering(wrapped, { env: context.env, billing, payload, providerLabel: 'stable-ts' });
    }

    // Direct audio_base64 path — client already encoded the audio
    const resp = await fetch(ALIGN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cf: { cacheTtl: 0 },
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    console.error('[align] fail', { message: err && err.message, stack: err && err.stack });
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
