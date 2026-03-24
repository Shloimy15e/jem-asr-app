// Proxy audio from R2 to avoid CORS issues
// GET /api/audio?url=<encoded-r2-url>

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const reqUrl = new URL(context.request.url);
  const url = reqUrl.searchParams.get('url');

  if (!url) {
    return new Response('Missing ?url= parameter', { status: 400 });
  }

  // Only allow proxying from audio.kohnai.ai
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'audio.kohnai.ai') {
      return new Response('Forbidden: only audio.kohnai.ai URLs allowed', { status: 403 });
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
