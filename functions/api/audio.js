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
    const resp = await fetch(url, { cf: { cacheTtl: 86400 } });
    if (!resp.ok) {
      return new Response('Audio not found', { status: resp.status });
    }

    return new Response(resp.body, {
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'audio/mpeg',
        'Content-Length': resp.headers.get('Content-Length') || '',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response('Failed to fetch audio', { status: 500 });
  }
}
