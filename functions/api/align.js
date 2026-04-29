// Proxy alignment requests to avoid CORS issues.
// POST /api/align -> https://api.runpod.ai/v2/$STABLE_TS_TRIM_ENDPOINT_ID/run (stable-ts, all)
//                 -> https://api.runpod.ai/v2/$IVRIT_ENDPOINT_ID/run (ivrit-iterative)
//                 -> https://align.kohnai.ai/api/align (legacy fallback when no endpoint id set)
//
// Forwards audio_url (+ optional trim_start / trim_end) straight to the pod.
// The Worker never touches audio bytes — prevents CF error 1102 on long audio.

const ALIGN_ENDPOINT = 'https://align.kohnai.ai/api/align';

function getAllowedDomains(env) {
  if (env?.ALLOWED_R2_DOMAINS) {
    return env.ALLOWED_R2_DOMAINS.split(',').map(d => d.trim()).filter(Boolean);
  }
  return ['audio.kohnai.ai', 'pub-c3d984b0acf3415ab61d979b1a4d9665.r2.dev'];
}

// Forward an already-validated audio_url request to a RunPod serverless
// endpoint via /runsync — RunPod holds the connection up to ~90s and returns
// the result inline when the job completes. Fits cleanly under Cloudflare's
// ~100s edge timeout (the previous /run + 5-min polling loop did not). For
// jobs that exceed 90s, RunPod returns 200 with status=IN_PROGRESS and a job
// id; we map that to 504 so the browser's retry loop kicks in.
//
//   label       — used in error messages, e.g. "ivrit-iterative" or "stable-ts-trim"
//   endpointId  — RunPod serverless endpoint id
//   apiKey      — RunPod API key (Bearer)
async function forwardToRunPodSync(payload, { endpointId, apiKey, label }, corsHeaders) {
  const input = {
    mode: payload.mode || 'align',
    audio_url: payload.audio_url,
    text: payload.text,
    language: payload.language || 'yi',
  };
  if (payload.trim_start != null) input.trim_start = payload.trim_start;
  if (payload.trim_end != null && payload.trim_end > 0) input.trim_end = payload.trim_end;

  const runResp = await fetch(`https://api.runpod.ai/v2/${endpointId}/runsync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input }),
  });
  if (!runResp.ok) {
    const body = await runResp.text().catch(() => '');
    return new Response(
      JSON.stringify({ error: `${label} /runsync failed: ${runResp.status}`, detail: body }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }
  const runData = await runResp.json();
  if (runData.status === 'COMPLETED') {
    return new Response(JSON.stringify(runData.output || {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  if (runData.status === 'FAILED' || runData.status === 'CANCELLED') {
    return new Response(
      JSON.stringify({ error: `${label} job ${runData.status}`, detail: runData.error || runData }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }
  // IN_QUEUE or IN_PROGRESS — runsync hit its ~90s limit. Surface 504 so the
  // browser retries; that submits a fresh job, but a warm worker handles it
  // much faster on the second pass.
  return new Response(
    JSON.stringify({ error: `${label} job still running after runsync window — retry`, jobId: runData.id, status: runData.status }),
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
  return forwardToRunPodSync(payload, { endpointId, apiKey, label: 'ivrit-iterative' }, corsHeaders);
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
  return forwardToRunPodSync(payload, { endpointId, apiKey, label: 'stable-ts-trim' }, corsHeaders);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestPost(context) {
  try {
    const payload = await context.request.json();

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
        return forwardToIvritPod(payload, context.env, CORS_HEADERS);
      }

      // ── stable-ts path ───────────────────────────────────────────────
      // Route all stable-ts traffic (trimmed and untrimmed) to the
      // RunPod trim pod when STABLE_TS_TRIM_ENDPOINT_ID is set. The
      // image handles untrimmed audio fine (trim params are optional).
      // Falls back to align.kohnai.ai only when the endpoint isn't
      // configured — that pod has historically been flaky.
      if (context.env?.STABLE_TS_TRIM_ENDPOINT_ID) {
        return forwardToStableTsTrimPod(payload, context.env, CORS_HEADERS);
      }
      const forwardPayload = { ...payload };
      delete forwardPayload.audio_duration; // pod doesn't use this
      const resp = await fetch(ALIGN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forwardPayload),
        cf: { cacheTtl: 0 },
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') || 'application/json',
          ...CORS_HEADERS,
        },
      });
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
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
