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

import { CORS_HEADERS, arrayBufferToBase64, getAllowedDomains } from '../_shared/utils.js';

const ALIGN_ENDPOINT = 'https://align.kohnai.ai/api/align';

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
