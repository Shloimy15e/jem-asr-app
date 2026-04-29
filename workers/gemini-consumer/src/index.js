// Gemini long-audio consumer worker.
//
// Consumes from the `gemini-asr-jobs` queue. For each message:
//   1. Fetch audio from R2 (via R2_BUCKET binding, by key)
//   2. Upload to GCS bucket (jem-chabad-asr-uploads)
//   3. Call Vertex AI :generateContent with fileData.fileUri = gs://...
//   4. Write { status, text|error, usage } to KV (GEMINI_RESULTS) under
//      `gemini:<jobId>` with a 7-day TTL
//
// Pages Functions cannot be queue consumers, so this lives as its own
// Worker (separate wrangler.toml). The Pages function `/api/transcribe`
// produces messages onto the same queue, and `/api/transcribe-status`
// reads results out of the same KV namespace.
//
// Why this exists: the Pages-Functions edge has a hard 60s wall-clock
// limit, and Vertex fine-tuned ckpt9 inference can take ~7s per minute
// of audio. So a 12-minute file would synchronously exceed the cap no
// matter how the audio is delivered. Moving the slow part to a queue
// consumer (15 min/message budget on Workers Paid) eliminates the limit.

const KV_TTL_SECONDS = 7 * 24 * 60 * 60;     // 7 days
const KV_PREFIX = 'gemini:';

// ── JWT helpers (RS256 over Web Crypto) ──────────────────────────────────

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function bytesToB64url(bytes) {
  let bin = '';
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getVertexAccessToken(saJson) {
  const sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  const { client_email, private_key } = sa;
  if (!client_email || !private_key) {
    throw new Error('Service account JSON missing client_email or private_key');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const pemBody = private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const keyDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok) {
    const msg = tokenData.error_description || tokenData.error || `Token exchange failed ${tokenResp.status}`;
    throw new Error('Vertex AI auth: ' + msg);
  }
  return tokenData.access_token;
}

// ── R2 -> bytes ──────────────────────────────────────────────────────────

async function fetchAudioBytes(env, audioKey, audioUrl) {
  // Prefer R2 binding (zero egress, no allowlist plumbing) when we have the
  // object key. Fall back to fetching the public R2 URL when only the URL
  // is available (e.g. cross-account / non-bound bucket).
  if (audioKey && env.R2_BUCKET) {
    const obj = await env.R2_BUCKET.get(audioKey);
    if (!obj) throw new Error(`R2 object not found: ${audioKey}`);
    const buf = await obj.arrayBuffer();
    return { bytes: new Uint8Array(buf), contentType: obj.httpMetadata?.contentType || null };
  }
  if (!audioUrl) throw new Error('No audio_key or audio_url provided');
  const resp = await fetch(audioUrl);
  if (!resp.ok) throw new Error(`Audio fetch ${resp.status} for ${audioUrl}`);
  const buf = await resp.arrayBuffer();
  return { bytes: new Uint8Array(buf), contentType: resp.headers.get('content-type') || null };
}

// ── bytes -> GCS ─────────────────────────────────────────────────────────

const MIME_BY_EXT = {
  mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm',
  m4a: 'audio/mp4', mp4: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
};

function mimeFor(audioKey, audioUrl, fallback) {
  const u = audioUrl || audioKey || '';
  const ext = (u.match(/\.([a-z0-9]{2,5})(?:\?|$)/i)?.[1] || '').toLowerCase();
  return MIME_BY_EXT[ext] || fallback || 'audio/mpeg';
}

async function uploadToGcs(env, accessToken, objectName, bytes, mimeType) {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(env.GCS_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': mimeType,
      'Content-Length': String(bytes.byteLength),
    },
    body: bytes,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`GCS upload ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return `gs://${env.GCS_BUCKET}/${objectName}`;
}

// ── Vertex call ──────────────────────────────────────────────────────────

const DEFAULT_GEMINI_PROMPT =
  'Transcribe this audio from the Chabad Lubavitcher Rebbe. ' +
  'Pay attention to the Chabad Russian Yiddish accent and nuances, ' +
  'and transcribe as it is written in Russian Yiddish spelling. ' +
  'Make sure to pay attention to the common lingo used often by the Rebbe.';

function buildVertexBody(gsUri, mimeType, prompt, systemInstruction) {
  const promptText = (typeof prompt === 'string' && prompt.trim().length > 0)
    ? prompt : DEFAULT_GEMINI_PROMPT;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { fileData: { mimeType, fileUri: gsUri } },
        { text: promptText },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  };
  if (typeof systemInstruction === 'string' && systemInstruction.trim().length > 0) {
    body.systemInstruction = { role: 'system', parts: [{ text: systemInstruction.trim() }] };
  }
  return body;
}

function extractText(data) {
  const t = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof t !== 'string') {
    throw new Error('Unexpected Vertex response: ' + JSON.stringify(data).slice(0, 300));
  }
  return t.trim();
}

function extractUsage(data) {
  const u = data?.usageMetadata || data?.usage_metadata || {};
  return {
    input_tokens:  u.promptTokenCount     ?? u.prompt_token_count     ?? null,
    output_tokens: u.candidatesTokenCount ?? u.candidates_token_count ?? null,
    audio_tokens:  u.audioTokenCount      ?? u.audio_token_count      ?? null,
  };
}

async function callVertex(env, accessToken, msg, gsUri, mimeType) {
  const sa = JSON.parse(env.GEMINI_SA_JSON);
  const projectId = msg.gemini_project_id || sa.project_id;
  const region    = msg.gemini_region     || 'us-central1';
  const endpointId = msg.gemini_endpoint_id;
  if (!endpointId) throw new Error('Missing gemini_endpoint_id');
  if (!projectId)  throw new Error('Missing gemini_project_id (and not in SA JSON)');

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/endpoints/${endpointId}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildVertexBody(gsUri, mimeType, msg.gemini_prompt, msg.gemini_system_instruction)),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Vertex ${resp.status}: ${data.error?.message || JSON.stringify(data).slice(0, 300)}`);
  }
  return { text: extractText(data), usage: extractUsage(data) };
}

// ── KV writers ───────────────────────────────────────────────────────────

async function kvWrite(env, jobId, value) {
  await env.GEMINI_RESULTS.put(KV_PREFIX + jobId, JSON.stringify(value), {
    expirationTtl: KV_TTL_SECONDS,
  });
}

// ── Main consumer entry ─────────────────────────────────────────────────

async function processOne(msg, env) {
  const { jobId } = msg;
  if (!jobId) throw new Error('message missing jobId');

  // Mark in-progress so the client can show a useful "uploading…" state
  await kvWrite(env, jobId, {
    status: 'processing',
    stage: 'fetching_audio',
    started_at: new Date().toISOString(),
  });

  const t0 = Date.now();

  // 1. Audio bytes (R2 binding preferred)
  const { bytes, contentType } = await fetchAudioBytes(env, msg.audio_key, msg.audio_url);
  const mimeType = contentType && contentType.startsWith('audio/')
    ? contentType
    : mimeFor(msg.audio_key, msg.audio_url, 'audio/mpeg');
  const ext = mimeType.split('/')[1] || 'mp3';
  const objectName = `transcribe/${jobId}.${ext === 'mpeg' ? 'mp3' : ext}`;

  await kvWrite(env, jobId, { status: 'processing', stage: 'gcs_upload', bytes: bytes.byteLength, started_at: new Date(t0).toISOString() });

  // 2. Mint SA token (used for both GCS PUT and Vertex POST)
  const accessToken = await getVertexAccessToken(env.GEMINI_SA_JSON);

  // 3. Upload to GCS
  const gsUri = await uploadToGcs(env, accessToken, objectName, bytes, mimeType);

  await kvWrite(env, jobId, { status: 'processing', stage: 'vertex_inference', gs_uri: gsUri, bytes: bytes.byteLength, started_at: new Date(t0).toISOString() });

  // 4. Vertex
  const { text, usage } = await callVertex(env, accessToken, msg, gsUri, mimeType);

  // 5. Done
  await kvWrite(env, jobId, {
    status: 'completed',
    text,
    usage,
    gs_uri: gsUri,
    bytes: bytes.byteLength,
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
  });
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body;
      const jobId = body?.jobId || '<no-id>';
      try {
        console.log('[gemini-consumer] start', { jobId, audioKey: body?.audio_key, hasUrl: !!body?.audio_url });
        await processOne(body, env);
        console.log('[gemini-consumer] done', { jobId });
        message.ack();
      } catch (err) {
        const errMsg = (err && err.message) || String(err);
        console.error('[gemini-consumer] error', { jobId, err: errMsg, stack: err?.stack || null });
        // Persist the failure for the client; ack so we don't retry forever
        // (max_retries on the queue handles transient infra issues).
        try {
          await env.GEMINI_RESULTS.put(KV_PREFIX + jobId, JSON.stringify({
            status: 'failed',
            error: errMsg,
            failed_at: new Date().toISOString(),
          }), { expirationTtl: KV_TTL_SECONDS });
        } catch (kvErr) {
          console.error('[gemini-consumer] kv-write-on-fail also failed', kvErr);
        }
        // Let the queue retry transient errors a couple times before DLQ.
        message.retry();
      }
    }
  },
};
