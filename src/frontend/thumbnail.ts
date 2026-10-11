/** Library thumbnails: square pictures of a model, at most this many pixels across. */
export const THUMBNAIL_PIXELS = 256;
/** Size of the square the stage draws the model into before it's trimmed. */
export const THUMBNAIL_RENDER_PIXELS = 512;

/**
 * Copy a square from the top-left of `source` (where the stage just drew the
 * model), trim the empty space around the model, and return it as an image
 * data URL. Must run in the same task as the drawing, before the browser shows
 * the canvas and clears its buffer. Null when nothing was drawn.
 */
export function squareThumbnail(source: HTMLCanvasElement, size: number): string | null {
  const copy = document.createElement('canvas');
  copy.width = size;
  copy.height = size;
  const context = copy.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(source, 0, 0, size, size, 0, 0, size, size);

  const { data } = context.getImageData(0, 0, size, size);
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[(y * size + x) * 4 + 3]! < 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  // The smallest square around what was drawn, with a little margin, kept inside the copy.
  const side = Math.min(size, Math.ceil(Math.max(maxX - minX + 1, maxY - minY + 1) * 1.06));
  const clamp = (start: number) => Math.min(size - side, Math.max(0, Math.round(start)));
  const left = clamp((minX + maxX + 1) / 2 - side / 2);
  const top = clamp((minY + maxY + 1) / 2 - side / 2);
  const outSize = Math.min(THUMBNAIL_PIXELS, side);
  const out = document.createElement('canvas');
  out.width = outSize;
  out.height = outSize;
  const outContext = out.getContext('2d')!;
  outContext.imageSmoothingQuality = 'high';
  outContext.drawImage(copy, left, top, side, side, 0, 0, outSize, outSize);
  return out.toDataURL('image/webp', 0.85);
}
