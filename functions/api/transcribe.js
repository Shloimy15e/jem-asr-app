// Proxy transcription requests to external ASR providers
// POST /api/transcribe
// Supports: gemini (Vertex AI service-account OR Gemini API key), yiddish-labs
// Whisper uses /api/align directly with mode:'transcribe'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

// Resolve audio_url (R2 only, SSRF-protected) or use provided base64.
async function resolveAudio(payload) {
  if (payload.audio_url) {
    let parsedUrl;
    try { parsedUrl = new URL(payload.audio_url); } catch {
      throw { status: 400, message: 'Invalid audio_url' };
    }
    if (parsedUrl.hostname !== 'audio.kohnai.ai') {
      throw { status: 400, message: 'audio_url must point to audio.kohnai.ai' };
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

async function handleYiddishLabs(audio, payload, env) {
  const yl_api_key = env.YL_API_KEY;
  if (!yl_api_key) throw { status: 500, message: 'Yiddish Labs API key not configured — set YL_API_KEY as a Cloudflare Worker secret' };
  const { yl_endpoint } = payload;

  // Sync endpoint handles files up to 5 minutes; longer files use the async endpoint.
  const endpoint = yl_endpoint || 'https://app.yiddishlabs.com/api/v1/transcriptions/sync';
  const mimeType = MIME_MAP[audio.format] || 'audio/mpeg';
  const filename = 'audio' + (audio.format || '.mp3');

  // Build multipart/form-data — field name is "file" per the YiddishLabs API spec
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

  // Auth uses X-API-KEY header per YiddishLabs API spec
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
    const msg = data.error?.message || data.error?.code || data.message || `Yiddish Labs API error ${resp.status}`;
    throw { status: resp.status, message: msg };
  }

  // Response: { id, status, text, summary, keywords, ... }
  const text = data.text;
  if (typeof text !== 'string') {
    throw { status: 502, message: 'Unexpected Yiddish Labs response: ' + JSON.stringify(data).slice(0, 300) };
  }
  return text.trim();
}

export async function onRequestPost(context) {
  try {
    const payload = await context.request.json();
    const { provider } = payload;
    const env = context.env;

    if (!provider) return errorResponse(400, 'Missing provider');

    const audio = await resolveAudio(payload);

    let text;
    if (provider === 'gemini') {
      text = await handleGemini(audio, payload, env);
    } else if (provider === 'yiddish-labs') {
      text = await handleYiddishLabs(audio, payload, env);
    } else {
      return errorResponse(400, `Unknown provider: ${provider}. Use gemini or yiddish-labs.`);
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
