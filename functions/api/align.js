// Proxy alignment requests to avoid CORS issues
// POST /api/align -> https://align.kohnai.ai/api/align
// Streams response body to avoid CF worker timeout on large responses
//
// If the request contains audio_url, the Worker fetches the audio itself and
// converts it to audio_base64 before forwarding — this avoids the ~25 MB
// Cloudflare Pages inbound body limit (the browser only sends a small URL).
//
// Trimming uses the XING VBR TOC when present for accurate byte seeking on
// variable-bitrate MP3 files. Falls back to byte-proportional for CBR files.

const ALIGN_ENDPOINT = 'https://align.kohnai.ai/api/align';

// Poll limit for the ivrit-iterative RunPod /run path. 5s intervals × 60 = 5 min total.
// Browser alignment.js retries on 502/504 so terminal long-audio jobs still land.
const IVRIT_POLL_MAX = 60;
const IVRIT_POLL_INTERVAL_MS = 5000;

function getAllowedDomains(env) {
  if (env?.ALLOWED_R2_DOMAINS) {
    return env.ALLOWED_R2_DOMAINS.split(',').map(d => d.trim()).filter(Boolean);
  }
  return ['audio.kohnai.ai'];
}

// Forward an already-validated audio_url request to the ivrit-iterative RunPod endpoint.
// The pod downloads the audio itself, so we never touch bytes in the Worker.
async function forwardToIvritPod(payload, env, corsHeaders) {
  const endpointId = env?.IVRIT_ENDPOINT_ID;
  const apiKey = env?.RUNPOD_API_KEY;
  if (!endpointId || !apiKey) {
    return new Response(
      JSON.stringify({ error: 'ivrit-iterative not configured: set IVRIT_ENDPOINT_ID and RUNPOD_API_KEY in Pages env' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }

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
      JSON.stringify({ error: `RunPod /run failed: ${runResp.status}`, detail: body }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }
  const runData = await runResp.json();
  if (!runData.id) {
    return new Response(
      JSON.stringify({ error: 'RunPod /run did not return job id', detail: runData }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    );
  }

  for (let i = 0; i < IVRIT_POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, IVRIT_POLL_INTERVAL_MS));
    const statusResp = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${runData.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!statusResp.ok) continue;
    const status = await statusResp.json();
    if (status.status === 'COMPLETED') {
      return new Response(JSON.stringify(status.output || {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    if (status.status === 'FAILED' || status.status === 'CANCELLED') {
      return new Response(
        JSON.stringify({ error: `RunPod job ${status.status}`, detail: status.error || status }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }
  }
  return new Response(
    JSON.stringify({ error: 'ivrit-iterative job still running after 5 min — retry to resume polling', jobId: runData.id }),
    { status: 504, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
  );
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Stream base64-encoded audio into a JSON body without buffering the full
// base64 string — keeps Worker memory at ~1x audio size instead of ~4.7x
// (the old approach held audioBuffer + binaryString + base64 + JSON copy).
function createStreamingJsonBody(payload, audioBytes) {
  const enc = new TextEncoder();
  const json = JSON.stringify(payload);
  const prefix = json.slice(0, -1) +
    (Object.keys(payload).length ? ',' : '') +
    '"audio_base64":"';
  const CHUNK = 3 * 8192; // 24 576 bytes — must be multiple of 3
  let off = 0;
  let sentPrefix = false;

  return new ReadableStream({
    pull(controller) {
      if (!sentPrefix) {
        controller.enqueue(enc.encode(prefix));
        sentPrefix = true;
        return;
      }
      if (off < audioBytes.length) {
        const end = Math.min(off + CHUNK, audioBytes.length);
        const last = end === audioBytes.length;
        const chars = [];
        for (let i = off; i < end; i += 3) {
          const rem = end - i;
          const a = audioBytes[i];
          const b = rem > 1 ? audioBytes[i + 1] : 0;
          const c = rem > 2 ? audioBytes[i + 2] : 0;
          chars.push(
            B64[a >> 2],
            B64[((a & 3) << 4) | (b >> 4)],
            rem > 1 ? B64[((b & 0xF) << 2) | (c >> 6)] : (last ? '=' : ''),
            rem > 2 ? B64[c & 0x3F] : (last ? '=' : ''),
          );
        }
        controller.enqueue(enc.encode(chars.join('')));
        off = end;
        return;
      }
      controller.enqueue(enc.encode('"}'));
      controller.close();
    },
  });
}

// Parse XING/INFO VBR TOC from the first bytes of an MP3 file.
// Returns a 100-entry Uint8Array (values 0-255) or null if not found.
// The TOC maps seek-point index (0-99, representing 0%-99% of duration)
// to relative byte position (value/255 * totalBytes).
function parseXingToc(headerBytes) {
  let pos = 0;
  // Skip ID3v2 tag if present
  if (headerBytes.length > 10 &&
      headerBytes[0] === 0x49 && headerBytes[1] === 0x44 && headerBytes[2] === 0x33) {
    const id3Size = ((headerBytes[6] & 0x7F) << 21) | ((headerBytes[7] & 0x7F) << 14) |
                    ((headerBytes[8] & 0x7F) << 7)  |  (headerBytes[9] & 0x7F);
    pos = 10 + id3Size;
    if (headerBytes[5] & 0x10) pos += 10; // footer flag
  }
  // Find first MP3 frame sync
  while (pos < headerBytes.length - 4) {
    if (headerBytes[pos] === 0xFF && (headerBytes[pos + 1] & 0xE0) === 0xE0) {
      const mpegVer   = (headerBytes[pos + 1] >> 3) & 0x3; // 3=MPEG1, 2=MPEG2
      const chanMode  = (headerBytes[pos + 3] >> 6) & 0x3; // 3=Mono
      // Side-info length determines where the XING tag lives inside the frame
      const sideInfo  = mpegVer === 3 ? (chanMode === 3 ? 17 : 32)
                                      : (chanMode === 3 ?  9 : 17);
      const xingPos   = pos + 4 + sideInfo;
      if (xingPos + 120 < headerBytes.length) {
        const tag = String.fromCharCode(
          headerBytes[xingPos], headerBytes[xingPos + 1],
          headerBytes[xingPos + 2], headerBytes[xingPos + 3],
        );
        if (tag === 'Xing' || tag === 'Info') {
          const flags = (headerBytes[xingPos + 4] << 24) | (headerBytes[xingPos + 5] << 16) |
                        (headerBytes[xingPos + 6] <<  8) |  headerBytes[xingPos + 7];
          if (flags & 0x4) { // bit 2 = TOC present
            let tocStart = xingPos + 8;
            if (flags & 0x1) tocStart += 4; // Frames field
            if (flags & 0x2) tocStart += 4; // Bytes field
            if (tocStart + 100 <= headerBytes.length) {
              return headerBytes.slice(tocStart, tocStart + 100);
            }
          }
        }
      }
      break; // valid frame but no XING — CBR file
    }
    pos++;
  }
  return null;
}

// Detect a suspect (corrupt) XING TOC. A valid TOC should be monotonically
// non-decreasing. If more than 20 consecutive entries are identical the encoder
// failed to compute seek points for that region; fall back to byte-proportional.
function isTocSuspect(toc) {
  if (!toc) return false;
  let maxRun = 1, run = 1;
  for (let i = 1; i < toc.length; i++) {
    run = (toc[i] === toc[i - 1]) ? run + 1 : 1;
    if (run > maxRun) maxRun = run;
  }
  return maxRun > 20;
}

// Convert a time fraction (0.0–1.0) to a byte offset using the XING TOC.
// Falls back to linear interpolation when toc is null (CBR files).
function tocByteOffset(toc, fraction, totalBytes) {
  if (!toc) return Math.floor(fraction * totalBytes);
  const fi = Math.max(0, Math.min(0.9999, fraction)) * 99;
  const i  = Math.floor(fi);
  const f  = fi - i;
  const t0 = toc[i];
  const t1 = i < 99 ? toc[i + 1] : 255;
  return Math.floor(((t0 + f * (t1 - t0)) / 255.0) * totalBytes);
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

      let audioBuffer;

      if (payload.trim_start != null || payload.trim_end != null) {
        // Trimming requested. Use two-step fetch:
        // 1. Fetch the first 64 KB to read the XING VBR TOC (if present).
        // 2. Use the TOC for accurate byte-seeking, then range-fetch only the needed slice.
        // This avoids loading the full file AND gives frame-accurate trimming for VBR MP3s.
        const headResp = await fetch(parsedUrl.href, { headers: { Range: 'bytes=0-65535' } });
        if (!headResp.ok && headResp.status !== 206) {
          return new Response(
            JSON.stringify({ error: `Failed to fetch audio header: ${headResp.status}` }),
            { status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
          );
        }
        const headBuffer = await headResp.arrayBuffer();

        // Determine total file size from Content-Range (e.g. "bytes 0-65535/4823040")
        let totalBytes;
        const contentRange = headResp.headers.get('Content-Range');
        if (contentRange) {
          totalBytes = parseInt(contentRange.split('/')[1], 10);
        } else {
          // File fits entirely in the 64 KB head fetch
          totalBytes = headBuffer.byteLength;
        }

        const rawToc       = parseXingToc(new Uint8Array(headBuffer));
        // Discard a suspect (flat/corrupt) TOC — fall back to byte-proportional.
        const toc          = isTocSuspect(rawToc) ? null : rawToc;
        const totalDur     = payload.audio_duration || 1;
        const trimStart    = payload.trim_start || 0;
        const trimEnd      = (payload.trim_end > 0) ? payload.trim_end : totalDur;
        const startByte    = tocByteOffset(toc, trimStart / totalDur, totalBytes);
        const endByte      = Math.min(tocByteOffset(toc, trimEnd   / totalDur, totalBytes), totalBytes);

        const sliceResp = await fetch(parsedUrl.href, {
          headers: { Range: `bytes=${startByte}-${endByte - 1}` },
        });
        if (!sliceResp.ok && sliceResp.status !== 206) {
          return new Response(
            JSON.stringify({ error: `Failed to fetch audio slice: ${sliceResp.status}` }),
            { status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
          );
        }
        audioBuffer = await sliceResp.arrayBuffer();
      } else {
        // No trimming — fetch the full audio as before.
        const audioResp = await fetch(parsedUrl.href);
        if (!audioResp.ok) {
          return new Response(
            JSON.stringify({ error: `Failed to fetch audio: ${audioResp.status}` }),
            { status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
          );
        }
        audioBuffer = await audioResp.arrayBuffer();
      }

      // Detect format from URL extension, default to .mp3
      const urlPath = new URL(payload.audio_url).pathname;
      const ext = urlPath.match(/(\.\w+)$/)?.[1] || '.mp3';

      // Clean up fields the GPU server doesn't understand
      delete payload.audio_url;
      delete payload.trim_start;
      delete payload.trim_end;
      delete payload.audio_duration;
      payload.audio_format = ext;

      // Stream base64 into the outgoing JSON body so the Worker never
      // holds audioBuffer + base64String + jsonString simultaneously.
      const body = createStreamingJsonBody(payload, new Uint8Array(audioBuffer));

      const resp = await fetch(ALIGN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
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
