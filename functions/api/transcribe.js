// Proxy transcription requests to external ASR providers
// POST /api/transcribe
// Supports: gemini (Vertex AI service-account OR Gemini API key), mendel
// Whisper uses /api/align directly with mode:'transcribe'

import {
  CORS_HEADERS,
  arrayBufferToBase64,
  getAllowedDomains,
  errorResponse,
  b64url,
  bytesToB64url,
} from '../_shared/utils.js';

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

// Resolve audio_url (SSRF-protected via ALLOWED_R2_DOMAINS) or use provided base64.
async function resolveAudio(payload, env) {
  if (payload.audio_url) {
    let parsedUrl;
    try { parsedUrl = new URL(payload.audio_url); } catch {
      throw { status: 400, message: 'Invalid audio_url' };
    }
    if (!getAllowedDomains(env).includes(parsedUrl.hostname)) {
      throw { status: 400, message: 'audio_url domain not in allowed list' };
    }
    if (parsedUrl.protocol !== 'https:') {
      throw { status: 400, message: 'audio_url must use https' };
    }
    const audioResp = await fetch(parsedUrl.href);
    if (!audioResp.ok) {
      throw { status: 502, message: `Failed to fetch audio: ${audioResp.status}` };
    }
    const buffer = await audioResp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const ext = parsedUrl.pathname.match(/(\.\w+)$/)?.[1] || '.mp3';
    return { base64: arrayBufferToBase64(buffer), format: ext, bytes };
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

function buildGeminiRequestBody(audio) {
  const mimeType = MIME_MAP[audio.format] || 'audio/mpeg';
  return {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType, data: audio.base64 } },
        { text: 'Transcribe this Yiddish audio accurately. Output only the transcription text, nothing else.' },
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

/**
 * Gemini via Vertex AI endpoint (service account auth).
 * Used for fine-tuned models deployed on GCP Vertex AI.
 */
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
    body: JSON.stringify(buildGeminiRequestBody(audio)),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw { status: resp.status, message: data.error?.message || `Vertex AI error ${resp.status}` };
  }
  return extractGeminiText(data);
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
    body: JSON.stringify(buildGeminiRequestBody(audio)),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw { status: resp.status, message: data.error?.message || `Gemini API error ${resp.status}` };
  }
  return extractGeminiText(data);
}

async function handleGemini(audio, payload, env) {
  // Secrets come from Cloudflare Worker env, never from the request payload
  if (env.GEMINI_SA_JSON) {
    return handleGeminiVertex(audio, payload, env.GEMINI_SA_JSON);
  }
  if (env.GEMINI_API_KEY) {
    return handleGeminiApiKey(audio, { ...payload, gemini_api_key: env.GEMINI_API_KEY });
  }
  throw { status: 500, message: 'Gemini credentials not configured — set GEMINI_SA_JSON (or GEMINI_API_KEY) as a Cloudflare Worker secret' };
}

async function handleMendel(audio, payload, env) {
  const yl_api_key = env.YL_API_KEY;
  if (!yl_api_key) throw { status: 500, message: 'Mendel API key not configured — set YL_API_KEY as a Cloudflare Worker secret' };
  const { yl_endpoint } = payload;

  const YL_BASE = 'https://app.yiddishlabs.com';
  // Sync endpoint: ≤5 min returns text immediately (200), >5 min returns job ID (201).
  const endpoint = yl_endpoint || `${YL_BASE}/api/v1/transcriptions/sync`;
  const mimeType = MIME_MAP[audio.format] || 'audio/mpeg';
  const filename = 'audio' + (audio.format || '.mp3');

  // Use raw bytes when available (URL path) to avoid base64 round-trip that triples memory
  const audioBytes = audio.bytes || Uint8Array.from(atob(audio.base64), c => c.charCodeAt(0));

  // Use FormData — runtime handles multipart encoding
  const formData = new FormData();
  formData.append('file', new Blob([audioBytes], { type: mimeType }), filename);
  formData.append('language', 'yi');
  formData.append('rapid', 'true');

  const authHeaders = { 'X-API-KEY': yl_api_key };

  // Submit to sync endpoint
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders,
    body: formData,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok && resp.status !== 201) {
    const msg = data.error?.message || data.error?.code || data.message || `Mendel API error ${resp.status}`;
    throw { status: resp.status, message: msg };
  }

  // Short file (≤5 min): sync endpoint returns 200 with text immediately
  if (typeof data.text === 'string') {
    return data.text.trim();
  }

  // Long file (>5 min): sync endpoint returns 201 with { id, status: "queued" }
  const jobId = data.id;
  if (!jobId) {
    throw { status: 502, message: 'Mendel: no text and no job ID in response: ' + JSON.stringify(data).slice(0, 300) };
  }

  // Poll GET /api/v1/transcriptions/:id until completed (max ~5 minutes)
  const POLL_INTERVAL = 10_000; // 10 seconds
  const MAX_POLLS = 30;         // 30 × 10s = 5 minutes
  const statusUrl = `${YL_BASE}/api/v1/transcriptions/${jobId}`;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const pollResp = await fetch(statusUrl, { headers: authHeaders });
    const pollData = await pollResp.json().catch(() => ({}));

    if (!pollResp.ok) {
      const msg = pollData.error?.message || `Mendel poll error ${pollResp.status}`;
      throw { status: pollResp.status, message: msg };
    }

    if (pollData.status === 'completed' && typeof pollData.text === 'string') {
      return pollData.text.trim();
    }

    if (pollData.status === 'failed' || pollData.status === 'error') {
      throw { status: 502, message: `Mendel transcription failed: ${pollData.error?.message || pollData.status}` };
    }
    // Otherwise status is "queued" or "processing" — keep polling
  }

  throw { status: 504, message: `Mendel transcription timed out after ${MAX_POLLS * POLL_INTERVAL / 1000}s — job ${jobId} still ${data.status || 'processing'}` };
}

export async function onRequestPost(context) {
  try {
    const payload = await context.request.json();
    const { provider } = payload;
    const env = context.env;

    if (!provider) return errorResponse(400, 'Missing provider');

    const audio = await resolveAudio(payload, env);

    let text;
    if (provider === 'gemini') {
      text = await handleGemini(audio, payload, env);
    } else if (provider === 'mendel') {
      text = await handleMendel(audio, payload, env);
    } else {
      return errorResponse(400, `Unknown provider: ${provider}. Use gemini or mendel.`);
    }

    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch (err) {
    const status = (typeof err.status === 'number') ? err.status : 502;
    const message = err.message || 'Transcription failed';
    return errorResponse(status, message);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
