// Proxy transcription requests to external ASR providers
// POST /api/transcribe
// Supports: gemini (Vertex AI service-account OR Gemini API key), mendel
// Whisper uses /api/align directly with mode:'transcribe'
//
// Billing integration (April 2026):
//   When the request includes a Bearer token, we resolve the caller's org,
//   pre-flight against credits/subscription, run the provider, then meter the
//   actual cost via finalizeUsage. Anonymous (no-bearer) requests still work
//   for internal staff flows that already enforce auth elsewhere.

import {
  getCallerUser, getCallerOrg, preflight, startUsage, finalizeUsage, failUsage,
  sbFetch,
} from './billing/_lib.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Base64url encode a UTF-8 string (for JWT header/payload)
function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Base64url encode raw bytes (for JWT signature)
function bytesToB64url(bytes) {
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Exchange a Google service account JSON for a short-lived OAuth2 access token.
 * Uses the Web Crypto API (RS256 JWT) — works in Cloudflare Workers.
 */
async function getVertexAccessToken(saJson) {
  const sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  const { client_email, private_key } = sa;
  if (!client_email || !private_key) {
    throw { status: 400, message: 'Service account JSON missing client_email or private_key' };
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

  // Parse PEM PKCS#8 private key (Google SA keys use \n literally in JSON)
  const pemBody = private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const keyDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
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
    throw { status: 502, message: `Vertex AI auth: ${msg}` };
  }

  return tokenData.access_token;
}

// Allowlist for SSRF protection. Matches align.js / audio.js so training files
// on the r2.dev public URL aren't blocked when ALLOWED_R2_DOMAINS is unset
// (e.g. preview deploys).
function getAllowedDomains(env) {
  if (env?.ALLOWED_R2_DOMAINS) {
    return env.ALLOWED_R2_DOMAINS.split(',').map(d => d.trim()).filter(Boolean);
  }
  return ['audio.kohnai.ai', 'pub-c3d984b0acf3415ab61d979b1a4d9665.r2.dev'];
}

// Resolve audio_url (R2 only, SSRF-protected) or use provided base64.
async function resolveAudio(payload, env) {
  if (payload.audio_url) {
    let parsedUrl;
    try { parsedUrl = new URL(payload.audio_url); } catch {
      throw { status: 400, message: 'Invalid audio_url' };
    }
    const allowedDomains = getAllowedDomains(env);
    if (!allowedDomains.includes(parsedUrl.hostname)) {
      throw { status: 400, message: `audio_url domain not in allowed list (${parsedUrl.hostname})` };
    }
    if (parsedUrl.protocol !== 'https:') {
      throw { status: 400, message: 'audio_url must use https' };
    }
    const audioResp = await fetch(parsedUrl.href);
    if (!audioResp.ok) {
      throw { status: 502, message: `Failed to fetch audio: ${audioResp.status}` };
    }
    const buffer = await audioResp.arrayBuffer();
    const ext = parsedUrl.pathname.match(/(\.\w+)$/)?.[1] || '.mp3';
    return { base64: arrayBufferToBase64(buffer), format: ext };
  }
  if (!payload.audio_base64) {
    throw { status: 400, message: 'Must provide audio_url or audio_base64' };
  }
  return { base64: payload.audio_base64, format: payload.audio_format || '.mp3' };
}

const MIME_MAP = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

const DEFAULT_GEMINI_PROMPT = 'transcribe this yiddish audio';

function buildGeminiRequestBody(audio, prompt) {
  const mimeType = MIME_MAP[audio.format] || 'audio/mpeg';
  const promptText = (typeof prompt === 'string' && prompt.trim().length > 0)
    ? prompt
    : DEFAULT_GEMINI_PROMPT;
  return {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType, data: audio.base64 } },
        { text: promptText },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  };
}

function extractGeminiText(data) {
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    throw { status: 502, message: 'Unexpected Gemini response: ' + JSON.stringify(data).slice(0, 300) };
  }
  return text.trim();
}

// Pull token usage out of a Gemini response. Both Vertex AI and the public API
// return usageMetadata; field names differ slightly between SDK versions so we
// accept the union.
function extractGeminiUsage(data) {
  const u = data?.usageMetadata || data?.usage_metadata || {};
  return {
    input_tokens:  u.promptTokenCount ?? u.prompt_token_count ?? null,
    output_tokens: u.candidatesTokenCount ?? u.candidates_token_count ?? null,
    audio_tokens:  u.audioTokenCount ?? u.audio_token_count ?? null,
  };
}

/**
 * Gemini via Vertex AI endpoint (service account auth).
 * Used for fine-tuned models deployed on GCP Vertex AI.
 */
// Estimate audio duration from base64 size as a rough fallback when the
// caller doesn't pass it. ~16 kbps for 16-bit/16k mono PCM, ~32 kbps for
// MP3/AAC. We use 32 kbps as a conservative middle estimate.
function estimateAudioSeconds(base64Len, format) {
  const bytes = (base64Len * 3) / 4;
  const kbps = (format === '.wav') ? 256 : 32;
  return Math.max(1, Math.round(bytes / ((kbps * 1024) / 8)));
}

async function handleGeminiVertex(audio, payload, saJson) {
  const { gemini_project_id, gemini_region, gemini_endpoint_id } = payload;
  if (!gemini_endpoint_id) throw { status: 500, message: 'Missing gemini_endpoint_id — set it in ASR Settings' };

  const sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  const projectId = gemini_project_id || sa.project_id;
  const region = gemini_region || 'us-central1';
  if (!projectId) throw { status: 400, message: 'Missing gemini_project_id (and not found in service account JSON)' };

  const accessToken = await getVertexAccessToken(saJson);

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/endpoints/${gemini_endpoint_id}:generateContent`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildGeminiRequestBody(audio, payload.gemini_prompt)),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw { status: resp.status, message: data.error?.message || `Vertex AI error ${resp.status}` };
  }
  return { text: extractGeminiText(data), usage: extractGeminiUsage(data) };
}

/**
 * Gemini via public API key (for Google AI Studio fine-tuned or base models).
 * Numeric model IDs use the tunedModels/ prefix; named strings use models/.
 */
async function handleGeminiApiKey(audio, payload) {
  const { gemini_api_key, gemini_model_id } = payload;
  if (!gemini_api_key) throw { status: 400, message: 'Missing gemini_api_key' };
  if (!gemini_model_id) throw { status: 400, message: 'Missing gemini_model_id' };

  const isNumeric = /^\d+$/.test(gemini_model_id);
  const modelPrefix = isNumeric ? 'tunedModels' : 'models';
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPrefix}/${gemini_model_id}:generateContent?key=${gemini_api_key}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeminiRequestBody(audio, payload.gemini_prompt)),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw { status: resp.status, message: data.error?.message || `Gemini API error ${resp.status}` };
  }
  return { text: extractGeminiText(data), usage: extractGeminiUsage(data) };
}

async function handleGemini(audio, payload, env) {
  // Secrets come from Cloudflare Worker env, never from the request payload.
  // Vertex (service-account) takes priority over the API-key path.
  // We accept either GEMINI_API_KEY or GOOGLE_API_KEY so the same Pages secret
  // works whether it was named for Gemini or for Google's broader API stack —
  // the official google-genai SDK uses the same fallback chain.
  if (env.GEMINI_SA_JSON) {
    return { ...(await handleGeminiVertex(audio, payload, env.GEMINI_SA_JSON)), provider: 'gemini-vertex' };
  }
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (apiKey) {
    return { ...(await handleGeminiApiKey(audio, { ...payload, gemini_api_key: apiKey })), provider: 'gemini' };
  }
  throw { status: 500, message: 'Gemini credentials not configured — set GEMINI_SA_JSON (or GEMINI_API_KEY / GOOGLE_API_KEY) as a Cloudflare Worker secret' };
}

async function handleMendel(audio, payload, env) {
  const yl_api_key = env.YL_API_KEY;
  if (!yl_api_key) throw { status: 500, message: 'Mendel API key not configured — set YL_API_KEY as a Cloudflare Worker secret' };
  const { yl_endpoint } = payload;

  // Sync endpoint handles files up to 5 minutes; longer files use the async endpoint.
  const endpoint = yl_endpoint || 'https://app.yiddishlabs.com/api/v1/transcriptions/sync';
  const mimeType = MIME_MAP[audio.format] || 'audio/mpeg';
  const filename = 'audio' + (audio.format || '.mp3');

  // Build multipart/form-data — field name is "file" per the Mendel API spec
  const boundary = '----FormBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const audioBytes = Uint8Array.from(atob(audio.base64), c => c.charCodeAt(0));

  const parts = [
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    audioBytes,
    enc.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nyi\r\n`),
    enc.encode(`--${boundary}--\r\n`),
  ];

  const totalLength = parts.reduce((s, p) => s + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) { body.set(p, offset); offset += p.length; }

  // Auth uses X-API-KEY header per Mendel API spec
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-API-KEY': yl_api_key,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data.error?.message || data.error?.code || data.message || `Mendel API error ${resp.status}`;
    throw { status: resp.status, message: msg };
  }

  // Mendel response shapes:
  //   short audio (<5 min)  → { id, status: 'completed', text, duration_seconds, ... }
  //   long  audio (>=5 min) → { id, status: 'processing', duration_seconds, credits_cost, ... }
  // For long jobs we return a processing handle so the outer worker can send
  // the client a job_id; the client then polls /api/transcribe-status until
  // Mendel reports completed.
  const status = String(data?.status || '').toLowerCase();
  const text = typeof data?.text === 'string' ? data.text.trim() : null;
  if (status === 'processing' || status === 'queued' || status === 'pending') {
    if (!data?.id) {
      throw { status: 502, message: 'Mendel returned processing without job id: ' + JSON.stringify(data).slice(0, 300) };
    }
    return {
      processing: true,
      job_id: data.id,
      usage: {
        audio_seconds: data?.duration_seconds || data?.duration || null,
        request_count: 1,
      },
    };
  }
  if (text == null) {
    throw { status: 502, message: 'Unexpected Mendel response: ' + JSON.stringify(data).slice(0, 300) };
  }
  return { text, usage: { audio_seconds: data?.duration_seconds || data?.duration || null, request_count: 1 } };
}

// ── Optional billing wrapper (only fires when caller is authed) ──────────

async function tryResolveBillingContext(request, env, payload) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  const auth = request.headers.get('authorization');
  if (!auth) return null;  // unauthed flow — staff/internal usage, no metering

  const { userId, email, accessToken } = await getCallerUser(request, env);
  const orgId = await getCallerOrg(env, accessToken, payload.org_id || null);
  const orgs = await sbFetch(env, `organizations?id=eq.${orgId}&select=default_markup_pct`);
  const markupPct = Number(orgs?.[0]?.default_markup_pct ?? 30);
  return { userId, email, accessToken, orgId, markupPct };
}

export async function onRequestPost(context) {
  let billing = null;
  let usageId = null;
  let providerUsage = null;

  try {
    const payload = await context.request.json();
    const { provider } = payload;
    const env = context.env;

    console.log('[transcribe] req', {
      provider,
      hasAudioUrl: !!payload.audio_url,
      audioUrlHost: payload.audio_url ? (() => { try { return new URL(payload.audio_url).hostname; } catch { return 'invalid'; } })() : null,
      hasAudioB64: !!payload.audio_base64,
      gemini_endpoint_id: payload.gemini_endpoint_id || null,
      gemini_project_id: payload.gemini_project_id || null,
      audio_id: payload.audio_id || null,
    });

    if (!provider) return errorResponse(400, 'Missing provider');

    // Optional billing context — only present when caller is authed
    billing = await tryResolveBillingContext(context.request, env, payload).catch(err => {
      // If auth header was passed but invalid, surface the 401
      throw err;
    });

    const audio = await resolveAudio(payload, env);
    const audioSeconds = payload.audio_duration_seconds || estimateAudioSeconds(audio.base64.length, audio.format);

    if (billing) {
      const pre = await preflight(env, billing.orgId, audioSeconds);
      if (!pre.allowed) {
        return errorResponse(402, 'Insufficient credits or no active subscription. Top up at /billing.html', { balance_micro_usd: pre.balance_micro_usd });
      }
      usageId = await startUsage(env, {
        orgId: billing.orgId,
        userId: billing.userId,
        audioId: payload.audio_id || null,
        provider,
        modelId: payload.gemini_model_id || payload.mendel_model || null,
        audioSeconds,
      });
      billing.chargeTo = pre.charge_to;
    }

    let result;
    if (provider === 'gemini') {
      result = await handleGemini(audio, payload, env);
    } else if (provider === 'mendel') {
      result = await handleMendel(audio, payload, env);
      result.provider = 'mendel';
    } else {
      return errorResponse(400, `Unknown provider: ${provider}. Use gemini or mendel.`);
    }

    // Mendel async kickoff path — long audio (>5 min) returns
    // { id, status:'processing' }. We hand the job_id back to the client so
    // it can poll /api/transcribe-status without burning a 100s edge timeout.
    if (result.processing) {
      console.log('[transcribe] async kickoff', { provider, jobId: result.job_id, usageId, audioSeconds });
      return new Response(JSON.stringify({
        status: 'processing',
        job_id: result.job_id,
        provider: result.provider || provider,
        usage_id: usageId || undefined,
        audio_seconds: audioSeconds,
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    if (billing && usageId) {
      providerUsage = {
        provider: result.provider || provider,
        model_id: payload.gemini_model_id || payload.mendel_model || null,
        audio_seconds: audioSeconds,
        request_count: 1,
        ...(result.usage || {}),
      };
      await finalizeUsage(env, {
        orgId: billing.orgId,
        usageId,
        providerUsage,
        markupPct: billing.markupPct,
        chargeTo: billing.chargeTo,
      }).catch(err => console.error('[billing] finalize failed:', err));
    }

    return new Response(JSON.stringify({ text: result.text, usage_id: usageId || undefined }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch (err) {
    if (usageId) {
      await failUsage(context.env, usageId, err.message || String(err));
    }
    const status = (typeof err.status === 'number') ? err.status : 502;
    const message = err.message || 'Transcription failed';
    console.error('[transcribe] fail', { status, message, stack: err.stack || null });
    return errorResponse(status, message);
  }
}

/**
 * GET /api/transcribe?health=1
 * Reports which transcription providers are configured (and, for Vertex,
 * verifies that the service-account JSON can actually mint an OAuth token).
 *
 * Response shape:
 *   {
 *     gemini:  { configured: true, mode: 'vertex', tokenOk: true, project: '...' },
 *     mendel:  { configured: true },
 *     whisper: { configured: true }
 *   }
 *
 * No secrets are returned — only booleans + the Vertex project ID (which
 * is already visible in the front-end ASR settings panel).
 */
export async function onRequestGet(context) {
  const env = context.env;
  const result = { gemini: {}, mendel: {}, whisper: {} };

  // Gemini
  if (env.GEMINI_SA_JSON) {
    result.gemini.configured = true;
    result.gemini.mode = 'vertex';
    try {
      const sa = typeof env.GEMINI_SA_JSON === 'string' ? JSON.parse(env.GEMINI_SA_JSON) : env.GEMINI_SA_JSON;
      result.gemini.project = sa.project_id || null;
      // Mint a token end-to-end; this is the actual smoke test.
      await getVertexAccessToken(env.GEMINI_SA_JSON);
      result.gemini.tokenOk = true;
    } catch (err) {
      result.gemini.tokenOk = false;
      result.gemini.error = (err && err.message) || String(err);
    }
  } else if (env.GEMINI_API_KEY) {
    result.gemini.configured = true;
    result.gemini.mode = 'api-key';
  } else {
    result.gemini.configured = false;
  }

  // Mendel
  result.mendel.configured = !!env.YL_API_KEY;

  // Whisper (RunPod) — uses align.kohnai.ai which doesn't need a key here
  result.whisper.configured = true;

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
