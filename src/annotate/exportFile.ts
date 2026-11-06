import { strokeBounds, type Bounds, type Stroke } from '../../shared/annotation.ts'
import { sanitizeFileName } from '../../shared/files.ts'
import { BOARD_UNIT_PX } from '../../shared/boardGeometry.ts'
import type { Rect, Size } from '../../shared/shareGeometry.ts'

// The arithmetic and the bytes of exporting (J4, e7-t07), with no canvas: what the picture covers,
// how it falls on pages, what the files are called and the PDF around the JPEGs. A hand-written PDF
// is under a hundred lines because all it holds is a picture per page; a library would be the
// largest thing in this chunk, for features nobody here uses. src/annotate/exportRender.ts draws.

/** The largest side and area a browser reliably draws (iOS Safari: 4096², 16.7 MP) */
export const MAX_EXPORT_SIDE = 4096
export const MAX_EXPORT_AREA = 16_000_000
/** Around the content of a board exported whole, world units (32 px at 100%) */
export const EXPORT_MARGIN = 0.032

/** A PDF page: landscape A4's shape, at 100% zoom */
export const PAGE_SIZE: Size = { width: 1600, height: 1131 }
/** A page is drawn at this many pixels per CSS pixel, for print and zooming in */
export const PAGE_PIXEL_RATIO = 2
/** A board drawn far apart becomes smaller rather than a hundred pages */
export const MAX_PDF_PAGES = 20
/** A page's long side in the PDF, points: A4's */
const PDF_LONG_SIDE = 842

export function paddedBounds(bounds: Bounds, margin = EXPORT_MARGIN): Bounds {
  return {
    minX: bounds.minX - margin,
    minY: bounds.minY - margin,
    maxX: bounds.maxX + margin,
    maxY: bounds.maxY + margin,
  }
}

/** A picture of `bounds` at 100%, or smaller when that is more than a browser can draw */
export function wholeBoardPicture(bounds: Bounds): { size: Size; rect: Rect } {
  const width = (bounds.maxX - bounds.minX) * BOARD_UNIT_PX
  const height = (bounds.maxY - bounds.minY) * BOARD_UNIT_PX
  const scale = Math.min(
    1,
    MAX_EXPORT_SIDE / width,
    MAX_EXPORT_SIDE / height,
    Math.sqrt(MAX_EXPORT_AREA / (width * height)),
  )
  const side = BOARD_UNIT_PX * scale
  return {
    size: {
      width: Math.max(1, Math.ceil(width * scale)),
      height: Math.max(1, Math.ceil(height * scale)),
    },
    rect: { x: -bounds.minX * side, y: -bounds.minY * side, width: side, height: side },
  }
}

export interface BoardPage {
  /** The page's size, CSS pixels */
  size: Size
  /** Where the world's unit square is on this page */
  rect: Rect
}

/**
 * All of a board on pages: one where it fits, otherwise a grid of them read left to right, top to
 * bottom, leaving out those with nothing on them. Past MAX_PDF_PAGES everything gets smaller until
 * it fits. Content that fits one page gets a page of its own shape, not a sheet with a corner used.
 */
export function boardPages(strokes: readonly Stroke[], bounds: Bounds): BoardPage[] {
  const worldWidth = bounds.maxX - bounds.minX
  const worldHeight = bounds.maxY - bounds.minY
  let side = BOARD_UNIT_PX
  let columns = Math.ceil((worldWidth * side) / PAGE_SIZE.width)
  let rows = Math.ceil((worldHeight * side) / PAGE_SIZE.height)
  while (columns * rows > MAX_PDF_PAGES) {
    side *= 0.8
    columns = Math.ceil((worldWidth * side) / PAGE_SIZE.width)
    rows = Math.ceil((worldHeight * side) / PAGE_SIZE.height)
  }
  if (columns === 1 && rows === 1) {
    return [
      {
        size: {
          width: Math.max(1, Math.ceil(worldWidth * side)),
          height: Math.max(1, Math.ceil(worldHeight * side)),
        },
        rect: { x: -bounds.minX * side, y: -bounds.minY * side, width: side, height: side },
      },
    ]
  }
  const covered = strokes.map(strokeBounds)
  const pages: BoardPage[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = bounds.minX + (column * PAGE_SIZE.width) / side
      const top = bounds.minY + (row * PAGE_SIZE.height) / side
      const right = left + PAGE_SIZE.width / side
      const bottom = top + PAGE_SIZE.height / side
      const used = covered.some(
        (box) => box.maxX >= left && box.minX <= right && box.maxY >= top && box.minY <= bottom,
      )
      if (used) {
        pages.push({
          size: PAGE_SIZE,
          rect: { x: -left * side, y: -top * side, width: side, height: side },
        })
      }
    }
  }
  return pages
}

const pad = (value: number) => String(value).padStart(2, '0')

/** YYYY-MM-DD HH-mm on this browser's clock: colons are not allowed in a Windows file name */
export const exportStamp = (at: Date): string =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}`

/**
 * AC-7.5: the room's name and the date, what it is and its extension, safe on any file system
 * (shared/files.ts: no paths, control or bidi characters). The product name when the room has none.
 */
export function exportFileName(
  roomName: string | null,
  what: string,
  at: Date,
  extension: 'png' | 'pdf',
): string {
  const parts = ['LongTalk', roomName ?? '', what, exportStamp(at)].filter((part) => part !== '')
  return sanitizeFileName(`${parts.join(' ')}.${extension}`)
}

/** One page of a PDF: a JPEG and its size in pixels */
export interface PdfImage {
  jpeg: Uint8Array
  width: number
  height: number
}

const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff)

/** A PDF text string that can hold any language: UTF-16BE with its byte order mark, in hex */
function pdfText(text: string): string {
  let hex = 'FEFF'
  for (let i = 0; i < text.length; i += 1) {
    hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
  }
  return `<${hex}>`
}

/**
 * A PDF with one picture per page, each page the picture's shape with its long side A4's: the
 * objects are a catalog, a page tree, an info dictionary, then a page, its content and its image for
 * each picture. Deterministic: there is no date in it, so the same pictures give the same bytes.
 */
export function buildImagePdf(pages: readonly PdfImage[], title: string): Uint8Array {
  const chunks: Uint8Array[] = []
  let length = 0
  const offsets: number[] = []
  const put = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? latin1(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  const object = (id: number, body: (string | Uint8Array)[]) => {
    offsets[id] = length
    put(`${id} 0 obj\n`)
    for (const part of body) put(part)
    put('\nendobj\n')
  }
  // The second line's bytes above 127 tell tools this is a binary file, as the PDF spec advises
  put('%PDF-1.4\n%')
  put(Uint8Array.of(0xe2, 0xe3, 0xcf, 0xd3))
  put('\n')
  const pageId = (index: number) => 4 + index * 3
  object(1, ['<< /Type /Catalog /Pages 2 0 R >>'])
  const kids = pages.map((_, index) => `${pageId(index)} 0 R`).join(' ')
  object(2, [`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`])
  object(3, [`<< /Title ${pdfText(title)} /Producer (LongTalk) >>`])
  pages.forEach(({ jpeg, width, height }, index) => {
    const id = pageId(index)
    const scale = PDF_LONG_SIDE / Math.max(width, height)
    const w = (width * scale).toFixed(2)
    const h = (height * scale).toFixed(2)
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`
    object(id, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`,
    ])
    object(id + 1, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`])
    object(id + 2, [
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      '\nendstream',
    ])
  })
  const objects = 4 + pages.length * 3
  const xref = length
  put(`xref\n0 ${objects}\n0000000000 65535 f \n`)
  for (let id = 1; id < objects; id += 1) {
    put(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  }
  put(`trailer\n<< /Size ${objects} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const out = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
