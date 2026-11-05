import {
  MAX_THUMB_BYTES,
  SAFE_IMAGE_TYPES,
  THUMB_SIDE_PX,
  normalizeMime,
} from '../../shared/files.ts'
import { thumbnailBackdrop } from '../styles/tokens.ts'

// A small JPEG made in the browser before an image is uploaded (I5, e5-t06): Cloudflare Images is
// paid, and showing the original in the chat would make every member download up to 25 MB, each
// time, on a phone too. The Worker checks it is an image like anything else that comes from here.

/** A picture's size to fit inside `side` × `side`, never enlarged */
export function fitWithin(
  width: number,
  height: number,
  side: number = THUMB_SIDE_PX,
): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height, 1))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * The thumbnail, or null when there is none to make: not an image type the page shows, a browser
 * that cannot decode it, or a result too big. The image then opens from its card instead.
 */
export async function makeThumbnail(file: File): Promise<Blob | null> {
  if (!SAFE_IMAGE_TYPES.has(normalizeMime(file.type))) return null
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const { width, height } = fitWithin(image.naturalWidth, image.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    // JPEG has no transparency
    context.fillStyle = thumbnailBackdrop
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.8),
    )
    return blob && blob.size <= MAX_THUMB_BYTES ? blob : null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
