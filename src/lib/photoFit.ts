// Gallery photos: shrink only what is too big. Pure logic, no DOM, so it can be tested in Node.
//
// The server refuses a photo over about 3.7 MB (5,000,000 characters once encoded). The app checks against a slightly lower
// number so a photo at the edge is not refused anyway. A photo under the limit is sent exactly as it is. A photo over the
// limit is re-encoded as a smaller copy in memory, just small enough to fit; the original file is never touched.

/** 3.5 MB of image bytes is about 4.67 million characters once encoded, safely under the server's 5,000,000. */
export const MAX_SEND_BYTES = 3_500_000;

/** The formats the server reads. Anything else (for example HEIC) has to be re-encoded even when it is small. */
const SERVER_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/** Quality of the re-encoded copy: high, so the only detail lost is what the size limit forces. */
export const SHRINK_QUALITY = 0.9;

const MAX_ENCODES = 8;
const MIN_SCALE = 0.1;

/** Whether the file can go to the server exactly as it is. */
export function canSendAsIs(file: { size: number; type: string }, limit = MAX_SEND_BYTES): boolean {
  return file.size <= limit && SERVER_TYPES.includes(file.type.toLowerCase());
}

/** Encodes the photo at `scale` (1 = full size) as a JPEG. Supplied by the browser code; faked in tests. */
export type Encode = (scale: number) => Promise<{ size: number; blob: Blob }>;

/** Scale at which a photo of `bytes` is expected to land just under `limit` (bytes grow about with the pixel count). */
function scaleFor(bytes: number, limit: number): number {
  return Math.sqrt(limit / bytes);
}

/**
 * Finds the largest copy that fits: the first try is the scale the arithmetic predicts. Still too big: shrink a bit more, until
 * it fits. Fits but with a lot of room to spare (a big PNG turns into a small JPEG): one step back up to keep more detail.
 */
export async function shrinkToFit(originalBytes: number, encode: Encode, limit = MAX_SEND_BYTES): Promise<Blob> {
  let scale = Math.min(1, scaleFor(Math.max(originalBytes, 1), limit) * 0.98);
  let best: { blob: Blob; size: number; scale: number } | null = null;

  for (let i = 0; i < MAX_ENCODES; i++) {
    const out = await encode(scale);
    if (out.size <= limit) {
      best = { blob: out.blob, size: out.size, scale };
      break;
    }
    // Still too big: aim just under the limit from what was actually measured, and always step down at least a little.
    scale = Math.min(scale * 0.95, scale * scaleFor(out.size, limit) * 0.97);
    if (scale < MIN_SCALE) break;
  }
  if (!best) throw new Error("The photo could not be made small enough.");

  // Plenty of room left and not yet full size: one try at a larger copy.
  if (best.scale < 1 && best.size < limit * 0.8) {
    const up = Math.min(1, best.scale * scaleFor(best.size, limit) * 0.97);
    if (up > best.scale * 1.03) {
      const out = await encode(up);
      if (out.size <= limit) return out.blob;
    }
  }
  return best.blob;
}
