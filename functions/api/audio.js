// Proxy audio from R2 to avoid CORS issues
// GET /api/audio?url=<encoded-r2-url>

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Returns the set of allowed R2 hostnames.
// Reads ALLOWED_R2_DOMAINS env var (comma-separated) if set; falls back to default.
function getAllowedDomains(env) {
  if (env?.ALLOWED_R2_DOMAINS) {
    return env.ALLOWED_R2_DOMAINS.split(',').map(d => d.trim()).filter(Boolean);
  }
  return ['audio.kohnai.ai'];
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const reqUrl = new URL(context.request.url);
  const url = reqUrl.searchParams.get('url');

  if (!url) {
    return new Response('Missing ?url= parameter', { status: 400 });
  }

  // Only allow proxying from approved R2 domains
  try {
    const parsed = new URL(url);
    const allowedDomains = getAllowedDomains(context.env);
    if (!allowedDomains.includes(parsed.hostname)) {
      return new Response('Forbidden: URL domain not in allowed list', { status: 403 });
    }
    if (parsed.protocol !== 'https:') {
      return new Response('Forbidden: only https URLs allowed', { status: 400 });
    }
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  try {
    // Forward Range header so the browser can seek within the audio
    const headers = {};
    const rangeHeader = context.request.headers.get('Range');
    if (rangeHeader) {
      headers['Range'] = rangeHeader;
    }

    const resp = await fetch(url, { headers, cf: { cacheTtl: 86400 } });
    if (!resp.ok && resp.status !== 206) {
      return new Response('Audio not found', { status: resp.status });
    }

    const responseHeaders = {
      'Content-Type': resp.headers.get('Content-Type') || 'audio/mpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
    };

    // Forward content-length and content-range for partial responses
    if (resp.headers.get('Content-Length')) {
      responseHeaders['Content-Length'] = resp.headers.get('Content-Length');
    }
    if (resp.headers.get('Content-Range')) {
      responseHeaders['Content-Range'] = resp.headers.get('Content-Range');
    }

    return new Response(resp.body, {
      status: resp.status, // 200 for full, 206 for partial
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response('Failed to fetch audio', { status: 500 });
  }
}
