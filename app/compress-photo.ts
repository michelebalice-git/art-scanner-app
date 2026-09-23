/** Smaller JPEG sent only when CLIP is unsure and the vision model must see the photo. */
const RERANK_MAX_EDGE = 768;
const RERANK_QUALITY = 0.72;

export function compressPhotoForRerank(source: HTMLCanvasElement): string {
  const scale = Math.min(1, RERANK_MAX_EDGE / Math.max(source.width, source.height));
  if (scale === 1) return source.toDataURL("image/jpeg", RERANK_QUALITY);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);

  const context = canvas.getContext("2d");
  if (!context) return source.toDataURL("image/jpeg", RERANK_QUALITY);

  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", RERANK_QUALITY);
}
