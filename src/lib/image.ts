import { SHRINK_QUALITY, canSendAsIs, shrinkToFit } from "./photoFit.ts";

export async function dataUrlToThumbnail(dataUrl: string, maxDim = 320): Promise<string> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process image.");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.72);
}

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image."));
    img.src = src;
  });
}

/**
 * A photo picked from the gallery, ready to send to the server.
 *   - Under the size limit and in a format the server reads: sent exactly as it is, no quality loss.
 *   - Too big (or in a format the server cannot read): a smaller JPEG copy is made in memory, just small enough to fit.
 * The original file is only read, never changed. Camera photos do not come through here.
 */
export async function prepareGalleryPhoto(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  if (canSendAsIs(file)) return readFileAsDataURL(file);

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const blob = await shrinkToFit(file.size, async (scale) => {
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not process image.");
      ctx.fillStyle = "#fff"; // a transparent PNG becomes white, not black, as a JPEG
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", SHRINK_QUALITY));
      canvas.width = canvas.height = 0; // let the phone free the memory at once
      if (!out) throw new Error("Could not process image.");
      return { size: out.size, blob: out };
    });
    return await blobToDataUrl(blob);
  } finally {
    URL.revokeObjectURL(url);
  }
}
