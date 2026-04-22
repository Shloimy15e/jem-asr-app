// Pure-JS MP3 frame walker — walks frame headers of a raw MP3 buffer to find
// byte offsets corresponding to a [trim_start, trim_end] time window.
// Frame-accurate within one MP3 frame (~26 ms at 44.1 kHz Layer 3).
// No decode, no ffmpeg, no subprocess — just reading frame headers.
//
// Use case: local trimming of MP3 audio for the training-data export pipeline.
// (Alignment pipeline now uses pod-side ffmpeg trim via stable-ts-aligner-trim;
// this walker is kept here for local disk-trimming without an ffmpeg dependency.)
//
// Returns { startByte, endByte } such that buffer.slice(startByte, endByte) is
// a valid MP3 covering audio from approximately trim_start to trim_end seconds.
// The XING/Info metadata frame at the file start (if present) is dropped from
// the output — players function fine without it for short slices.
export function extractMp3SliceByTime(buffer, trimStart, trimEnd) {
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  // Skip ID3v2 tag if present
  if (bytes.length > 10 &&
      bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const id3Size = ((bytes[6] & 0x7F) << 21) | ((bytes[7] & 0x7F) << 14) |
                    ((bytes[8] & 0x7F) << 7)  |  (bytes[9] & 0x7F);
    pos = 10 + id3Size;
    if (bytes[5] & 0x10) pos += 10; // footer flag
  }

  let elapsedTime = 0;
  let startByte = -1;
  let endByte = -1;
  let firstAudioFrame = true;

  while (pos + 4 <= bytes.length) {
    // Sync word: 0xFF 0xEx (11 bits of 1)
    if (bytes[pos] !== 0xFF || (bytes[pos + 1] & 0xE0) !== 0xE0) {
      pos++;
      continue;
    }
    const header = parseMp3FrameHeader(bytes, pos);
    if (!header) { pos++; continue; }

    // Detect XING/Info metadata frame — only the first audio-style frame can be one
    if (firstAudioFrame) {
      firstAudioFrame = false;
      const xingPos = pos + 4 + header.sideInfoLen;
      if (xingPos + 4 < bytes.length) {
        const tag = String.fromCharCode(
          bytes[xingPos], bytes[xingPos + 1], bytes[xingPos + 2], bytes[xingPos + 3],
        );
        if (tag === 'Xing' || tag === 'Info') {
          pos += header.frameSize;
          continue;
        }
      }
    }

    if (startByte === -1 && elapsedTime >= trimStart) {
      startByte = pos;
    }
    if (trimEnd > 0 && elapsedTime >= trimEnd) {
      endByte = pos;
      break;
    }

    elapsedTime += header.duration;
    pos += header.frameSize;
  }

  if (startByte === -1) startByte = pos;          // trim_start past end → empty
  if (endByte   === -1) endByte   = bytes.length; // trim_end = 0 or past end

  return { startByte, endByte };
}

// Parse a 4-byte MP3 frame header at `pos`. Returns { frameSize, duration,
// sideInfoLen, sampleRate, bitrate, layer } or null if the bytes don't form a
// valid header. Handles MPEG1, MPEG2, and MPEG2.5; Layers 1, 2, and 3.
export function parseMp3FrameHeader(bytes, pos) {
  if (pos + 4 > bytes.length) return null;
  if (bytes[pos] !== 0xFF || (bytes[pos + 1] & 0xE0) !== 0xE0) return null;

  const versionId  = (bytes[pos + 1] >> 3) & 0x03; // 00=2.5, 01=reserved, 10=2, 11=1
  const layerBits  = (bytes[pos + 1] >> 1) & 0x03; // 00=reserved, 01=L3, 10=L2, 11=L1
  const bitrateIdx = (bytes[pos + 2] >> 4) & 0x0F;
  const sampleIdx  = (bytes[pos + 2] >> 2) & 0x03;
  const padding    = (bytes[pos + 2] >> 1) & 0x01;
  const chanMode   = (bytes[pos + 3] >> 6) & 0x03;

  if (versionId === 1) return null;                       // reserved
  if (layerBits === 0) return null;                       // reserved
  if (bitrateIdx === 0 || bitrateIdx === 15) return null; // free / bad
  if (sampleIdx === 3) return null;                       // reserved

  const isMpeg1  = versionId === 3;
  const isMpeg25 = versionId === 0;
  const layer    = 4 - layerBits; // bits 11→1, 10→2, 01→3

  // Bitrate tables (kbps)
  const BR_M1L1  = [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448];
  const BR_M1L2  = [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384];
  const BR_M1L3  = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
  const BR_M2L1  = [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256];
  const BR_M2L23 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  let bitrate;
  if (isMpeg1) bitrate = layer === 1 ? BR_M1L1[bitrateIdx] : layer === 2 ? BR_M1L2[bitrateIdx] : BR_M1L3[bitrateIdx];
  else         bitrate = layer === 1 ? BR_M2L1[bitrateIdx] : BR_M2L23[bitrateIdx];
  if (!bitrate) return null;

  // Sample rate tables (Hz)
  const SR_M1  = [44100, 48000, 32000];
  const SR_M2  = [22050, 24000, 16000];
  const SR_M25 = [11025, 12000, 8000];
  const sampleRate = isMpeg1 ? SR_M1[sampleIdx] : isMpeg25 ? SR_M25[sampleIdx] : SR_M2[sampleIdx];
  if (!sampleRate) return null;

  // Samples per frame
  const samplesPerFrame =
    layer === 1 ? 384 :
    layer === 2 ? 1152 :
    /* layer 3 */ (isMpeg1 ? 1152 : 576);

  // Frame size in bytes
  let frameSize;
  if (layer === 1) {
    frameSize = (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4;
  } else {
    // Layer 2 always uses coef 144; Layer 3 uses 144 for MPEG1, 72 for MPEG2/2.5
    const coef = (layer === 3 && !isMpeg1) ? 72 : 144;
    frameSize = Math.floor((coef * bitrate * 1000) / sampleRate) + padding;
  }
  if (frameSize < 4) return null;

  // Side info length (Layer 3 only — used for XING tag detection)
  const sideInfoLen = layer === 3
    ? (isMpeg1 ? (chanMode === 3 ? 17 : 32) : (chanMode === 3 ? 9 : 17))
    : 0;

  return {
    frameSize,
    duration: samplesPerFrame / sampleRate,
    sideInfoLen,
    sampleRate,
    bitrate,
    layer,
  };
}
