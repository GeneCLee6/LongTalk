import { strokesBounds, type Stroke } from '../../shared/annotation.ts'
import type { Rect, Size } from '../../shared/shareGeometry.ts'
import { annotation, color } from '../styles/tokens.ts'
import { drawStrokes } from './draw.ts'
import {
  MAX_EXPORT_AREA,
  MAX_EXPORT_SIDE,
  PAGE_PIXEL_RATIO,
  boardPages,
  buildImagePdf,
  paddedBounds,
  wholeBoardPicture,
  type PdfImage,
} from './exportFile.ts'

// Exporting (J4, e7-t07) happens in the browser on canvases of its own, never on the one on screen,
// and nothing leaves the browser. Lazy with the rest of src/annotate.

/** JPEG in a PDF: a sheet of lines stays crisp at this quality and a screen stays small */
const JPEG_QUALITY = 0.92

const canvasOf = ({ width, height }: Size): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the browser could not encode it'))),
      type,
      quality,
    )
  })

/** The marks on a sheet of paper; `ratio` device pixels per pixel of `size` */
function drawBoard(strokes: readonly Stroke[], size: Size, rect: Rect, ratio: number) {
  const canvas = canvasOf({ width: size.width * ratio, height: size.height * ratio })
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2D canvas')
  drawStrokes(ctx, strokes, rect, ratio, canvas, false)
  // Under what was just drawn: the same paper as on screen, without the grid (it is not content)
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = annotation.boardPaper
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = 'source-over'
  return canvas
}

/** PNG of what this person has on screen: the tile's size at its pixel ratio */
export function boardViewPng(
  strokes: readonly Stroke[],
  box: Size,
  rect: Rect,
  ratio: number,
): Promise<Blob> {
  const size = { width: Math.round(box.width), height: Math.round(box.height) }
  return encode(drawBoard(strokes, size, rect, ratio), 'image/png')
}

/** PNG of all that is drawn, wherever it is. An empty board is an empty sheet */
export function boardWholePng(strokes: readonly Stroke[]): Promise<Blob> {
  const bounds = strokesBounds(strokes) ?? { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }
  const { size, rect } = wholeBoardPicture(paddedBounds(bounds))
  return encode(drawBoard(strokes, size, rect, 1), 'image/png')
}

const jpegPage = async (canvas: HTMLCanvasElement): Promise<PdfImage> => {
  const blob = await encode(canvas, 'image/jpeg', JPEG_QUALITY)
  return {
    jpeg: new Uint8Array(await blob.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
  }
}

/** All that is drawn as a PDF, pages as needed (exportFile.ts boardPages) */
export async function boardPdf(strokes: readonly Stroke[], title: string): Promise<Blob> {
  const bounds = strokesBounds(strokes) ?? { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }
  const pages: PdfImage[] = []
  // One at a time: a canvas is let go before the next, so twenty pages never sit in memory
  for (const { size, rect } of boardPages(strokes, paddedBounds(bounds))) {
    pages.push(await jpegPage(drawBoard(strokes, size, rect, PAGE_PIXEL_RATIO)))
  }
  return new Blob([buildImagePdf(pages, title) as BlobPart], { type: 'application/pdf' })
}

/** How big a share's picture may be drawn: its real size unless a browser cannot manage that */
export function shareFrameSize(video: Size): Size {
  const scale = Math.min(
    1,
    MAX_EXPORT_SIDE / video.width,
    MAX_EXPORT_SIDE / video.height,
    Math.sqrt(MAX_EXPORT_AREA / (video.width * video.height)),
  )
  return { width: Math.round(video.width * scale), height: Math.round(video.height * scale) }
}

/**
 * The share's current frame and the marks on it. The whole picture at the size it arrives, whatever
 * the zoom on screen. `picture` false: only the marks, as on a sharer's own view with the picture
 * hidden (J3), which would otherwise put what they chose not to look at into a file.
 */
export function drawShareFrame(
  video: HTMLVideoElement,
  strokes: readonly Stroke[],
  picture: boolean,
): HTMLCanvasElement {
  const size = shareFrameSize({ width: video.videoWidth, height: video.videoHeight })
  const canvas = canvasOf(size)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2D canvas')
  ctx.fillStyle = color.tileTo
  ctx.fillRect(0, 0, size.width, size.height)
  if (picture) ctx.drawImage(video, 0, 0, size.width, size.height)
  const marks = canvasOf(size)
  const marksCtx = marks.getContext('2d')
  if (!marksCtx) throw new Error('no 2D canvas')
  drawStrokes(marksCtx, strokes, { x: 0, y: 0, ...size }, 1, marks, true)
  ctx.drawImage(marks, 0, 0)
  return canvas
}

export const sharePng = (frame: HTMLCanvasElement): Promise<Blob> => encode(frame, 'image/png')

export async function sharePdf(frame: HTMLCanvasElement, title: string): Promise<Blob> {
  return new Blob([buildImagePdf([await jpegPage(frame)], title) as BlobPart], {
    type: 'application/pdf',
  })
}

/** Hands a made file to the browser's downloads, as the other downloads in the app do */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  // Long enough for the browser to have started on it
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
