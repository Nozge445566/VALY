// Image input checks. We never forward anything we have not looked at ourselves.

const MAX_BASE64_CHARS = 5_000_000; // about 3.7 MB of image bytes, under the API limit of 5 MB

export interface ParsedImage {
  mediaType: string;
  base64: string;
}

/** Look at the first bytes to find the real type. The declared type is not trusted. */
export function sniffMediaType(base64: string): string | null {
  let bytes: Uint8Array;
  try {
    const bin = atob(base64.slice(0, 24));
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function parseDataUrl(value: unknown): ParsedImage | null {
  if (typeof value !== "string") return null;
  const head = /^data:([a-zA-Z]+\/[a-zA-Z0-9.+-]+);base64,/.exec(value);
  if (!head) return null;
  const base64 = value.slice(head[0].length);
  if (base64.length < 100 || base64.length > MAX_BASE64_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const mediaType = sniffMediaType(base64);
  if (!mediaType) return null;
  return { mediaType, base64 };
}
