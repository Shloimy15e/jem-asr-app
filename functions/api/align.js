// Proxy alignment requests to avoid CORS issues
// POST /api/align -> https://align.kohnai.ai/api/align
// Streams response body to avoid CF worker timeout on large responses
//
// If the request contains audio_url, the Worker fetches the audio itself and
// converts it to audio_base64 before forwarding — this avoids the ~25 MB
// Cloudflare Pages inbound body limit (the browser only sends a small URL).

const ALIGN_ENDPOINT = 'https://align.kohnai.ai/api/align';

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

export async function onRequestPost(context) {
  try {
    const payload = await context.request.json();

    // If the client sent audio_url, resolve it to base64 here in the Worker.
    // This keeps the browser→CF request tiny (just a URL string) while still
    // sending audio_base64 to RunPod in the format it already understands.
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
      if (parsedUrl.hostname !== 'audio.kohnai.ai') {
        return new Response(
          JSON.stringify({ error: 'audio_url must point to audio.kohnai.ai' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
        );
      }
      if (parsedUrl.protocol !== 'https:') {
        return new Response(
          JSON.stringify({ error: 'audio_url must use https' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
        );
      }

      const audioResp = await fetch(parsedUrl.href);
      if (!audioResp.ok) {
        return new Response(
          JSON.stringify({ error: `Failed to fetch audio: ${audioResp.status}` }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
        );
      }
      let audioBuffer = await audioResp.arrayBuffer();

      // Apply byte-proportional trim if requested — keeps browser→CF request tiny
      // (the browser sends just a URL + trim params, not the full audio base64)
      if (payload.trim_start != null || payload.trim_end != null) {
        const totalBytes = audioBuffer.byteLength;
        const totalDuration = payload.audio_duration || 1;
        const trimStart = payload.trim_start || 0;
        const trimEnd = (payload.trim_end > 0) ? payload.trim_end : totalDuration;
        const startByte = Math.floor(trimStart / totalDuration * totalBytes);
        const endByte = Math.min(Math.floor(trimEnd / totalDuration * totalBytes), totalBytes);
        audioBuffer = audioBuffer.slice(startByte, endByte);
      }
      delete payload.trim_start;
      delete payload.trim_end;
      delete payload.audio_duration;

      const base64 = arrayBufferToBase64(audioBuffer);

      // Detect format from URL extension, default to .mp3
      const urlPath = new URL(payload.audio_url).pathname;
      const ext = urlPath.match(/(\.\w+)$/)?.[1] || '.mp3';

      delete payload.audio_url;
      payload.audio_base64 = base64;
      payload.audio_format = ext;
    }

    const resp = await fetch(ALIGN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cf: { cacheTtl: 0 },
    });

    // Stream the response body directly — don't buffer with resp.text()
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
