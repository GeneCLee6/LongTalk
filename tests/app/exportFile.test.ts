// J4 (e7-t07; AC-7.5): the files exporting makes. The PDF is parsed by hand here against its own
// cross-reference table, and its structure compared with a golden; the real browser's PNG and PDF
// are read back in e2e/local/whiteboard.spec.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { strokesBounds, type NormPoint, type Stroke } from '../../shared/annotation.ts'
import {
  EXPORT_MARGIN,
  MAX_EXPORT_AREA,
  MAX_EXPORT_SIDE,
  MAX_PDF_PAGES,
  PAGE_PIXEL_RATIO,
  PAGE_SIZE,
  boardPages,
  buildImagePdf,
  exportFileName,
  paddedBounds,
  wholeBoardPicture,
} from '../../src/annotate/exportFile.ts'
import {
  boardPdf,
  boardViewPng,
  boardWholePng,
  drawShareFrame,
  shareFrameSize,
} from '../../src/annotate/exportRender.ts'

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('')

/** Enough of a JPEG for a PDF to carry: its markers and what the test can find again */
const fakeJpeg = (fill: number) => Uint8Array.of(0xff, 0xd8, fill, fill, fill, 0xff, 0xd9)

/** Reads a PDF the way a viewer starts to: from the end, through the table, to each object */
function readPdf(bytes: Uint8Array) {
  const text = latin1(bytes)
  expect(text.startsWith('%PDF-1.4\n')).toBe(true)
  expect(text.endsWith('%%EOF\n')).toBe(true)
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1])
  expect(text.slice(startxref, startxref + 5)).toBe('xref\n')
  const table = text.slice(startxref).split('\n')
  const count = Number(table[1].split(' ')[1])
  expect(table[2]).toBe('0000000000 65535 f ')
  const objects = new Map<number, string>()
  for (let id = 1; id < count; id += 1) {
    const line = table[2 + id]
    expect(line).toMatch(/^\d{10} 00000 n $/)
    const at = Number(line.slice(0, 10))
    const end = text.indexOf('\nendobj\n', at)
    expect(text.slice(at, at + `${id} 0 obj\n`.length)).toBe(`${id} 0 obj\n`)
    objects.set(id, text.slice(at + `${id} 0 obj\n`.length, end))
  }
  const trailer = /trailer\n(<<.*>>)\n/.exec(text)![1]
  expect(trailer).toContain(`/Size ${count}`)
  return { objects, trailer, text }
}

describe('buildImagePdf', () => {
  it('has the structure it should (golden)', () => {
    const pdf = buildImagePdf([{ jpeg: fakeJpeg(1), width: 1600, height: 1131 }], 'AB')
    expect(latin1(pdf).replace(/[\x80-\xff]/g, '?')).toBe(
      [
        '%PDF-1.4',
        '%????',
        '1 0 obj',
        '<< /Type /Catalog /Pages 2 0 R >>',
        'endobj',
        '2 0 obj',
        '<< /Type /Pages /Count 1 /Kids [4 0 R] >>',
        'endobj',
        '3 0 obj',
        '<< /Title <FEFF00410042> /Producer (LongTalk) >>',
        'endobj',
        '4 0 obj',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842.00 595.19] /Resources << /XObject << /Im0 6 0 R >> >> /Contents 5 0 R >>',
        'endobj',
        '5 0 obj',
        '<< /Length 36 >>',
        'stream',
        'q 842.00 0 0 595.19 0 0 cm /Im0 Do Q',
        'endstream',
        'endobj',
        '6 0 obj',
        '<< /Type /XObject /Subtype /Image /Width 1600 /Height 1131 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 7 >>',
        'stream',
        '?\u0001\u0001\u0001?',
        'endstream',
        'endobj',
        'xref',
        '0 7',
        '0000000000 65535 f ',
        '0000000015 00000 n ',
        '0000000064 00000 n ',
        '0000000121 00000 n ',
        '0000000185 00000 n ',
        '0000000321 00000 n ',
        '0000000407 00000 n ',
        'trailer',
        '<< /Size 7 /Root 1 0 R /Info 3 0 R >>',
        'startxref',
        '581',
        '%%EOF',
        '',
      ]
        .join('\n')
        // The JPEG's first and last markers are two bytes each
        .replace('?\u0001\u0001\u0001?', '??\u0001\u0001\u0001??'),
    )
  })

  it('every table offset points at its object, on many pages', () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({
      jpeg: fakeJpeg(i + 10),
      width: 800 + i,
      height: 600,
    }))
    const { objects, trailer } = readPdf(buildImagePdf(pages, 'Room'))
    expect(trailer).toContain('/Root 1 0 R')
    expect(objects.get(2)).toContain('/Count 5')
    expect(objects.size).toBe(3 + 5 * 3)
    pages.forEach(({ width, height }, index) => {
      const image = objects.get(4 + index * 3 + 2)!
      expect(image).toContain(`/Width ${width} /Height ${height}`)
      expect(image).toContain('/Filter /DCTDecode /Length 7')
    })
  })

  it('declares each stream with its true length, and carries the JPEG bytes untouched', () => {
    const jpeg = fakeJpeg(0x7a)
    const bytes = buildImagePdf([{ jpeg, width: 10, height: 20 }], 'x')
    const { objects } = readPdf(bytes)
    const content = objects.get(5)!
    const length = Number(/\/Length (\d+)/.exec(content)![1])
    expect(/stream\n(.*)\nendstream/.exec(content)![1]).toHaveLength(length)
    expect(latin1(bytes)).toContain(latin1(jpeg))
  })

  it('a portrait page is portrait, with its long side A4', () => {
    const { objects } = readPdf(buildImagePdf([{ jpeg: fakeJpeg(1), width: 500, height: 1000 }], 'x'))
    expect(objects.get(4)).toContain('/MediaBox [0 0 421.00 842.00]')
  })

  it('holds a title in any language, and the same pictures give the same bytes', () => {
    const page = { jpeg: fakeJpeg(1), width: 1, height: 1 }
    const { objects } = readPdf(buildImagePdf([page], '週會'))
    expect(objects.get(3)).toContain('/Title <FEFF90316703>')
    expect(buildImagePdf([page], 'x')).toEqual(buildImagePdf([page], 'x'))
  })
})

describe('the file name', () => {
  const at = new Date(2026, 10, 6, 9, 5)

  it('has the room and the date (AC-7.5)', () => {
    expect(exportFileName('週會', '白板', at, 'png')).toBe('LongTalk 週會 白板 2026-11-06 09-05.png')
    expect(exportFileName('Standup', 'whiteboard', at, 'pdf')).toBe(
      'LongTalk Standup whiteboard 2026-11-06 09-05.pdf',
    )
  })

  it('without a room name it is still a good name', () => {
    expect(exportFileName(null, '白板', at, 'pdf')).toBe('LongTalk 白板 2026-11-06 09-05.pdf')
  })

  it('a room name cannot make a path, hide the extension or break a file system', () => {
    const name = exportFileName('../..\\evil‮fdp.exe:*?', '白板', at, 'png')
    expect(name).toMatch(/\.png$/)
    expect(name).not.toMatch(/[/\\:*?‮]/)
    expect([...exportFileName('長'.repeat(500), '白板', at, 'png')].length).toBeLessThanOrEqual(120)
    expect(exportFileName('長'.repeat(500), '白板', at, 'png')).toMatch(/\.png$/)
  })
})

const stroke = (id: string, points: NormPoint[]): Stroke => ({
  id,
  by: 'm',
  tool: 'pen',
  color: 'rose',
  width: 'medium',
  points,
})

describe('what an export covers', () => {
  it('bounds cover the line as well as its points, and every tool', () => {
    expect(strokesBounds([])).toBeNull()
    const line = strokesBounds([stroke('a', [[0, 0], [1, 2]])])!
    expect(line.minX).toBeCloseTo(-0.003)
    expect(line.maxY).toBeCloseTo(2.003)
    const arrow = strokesBounds([
      { ...stroke('b', [[0, 0], [1, 0]]), tool: 'arrow' },
    ])!
    expect(arrow.maxX).toBeGreaterThan(1.02)
    const text = strokesBounds([{ ...stroke('c', [[5, 5]]), tool: 'text', text: 'hello' }])!
    expect(text.minX).toBe(5)
    expect(text.maxX).toBeGreaterThan(5.05)
  })

  it('a board fitting a page gets one page of its own shape', () => {
    const strokes = [stroke('a', [[0, 0], [0.5, 0.25]])]
    const bounds = paddedBounds(strokesBounds(strokes)!)
    const pages = boardPages(strokes, bounds)
    expect(pages).toHaveLength(1)
    expect(pages[0].size.width).toBe(Math.ceil((bounds.maxX - bounds.minX) * 1000))
    expect(pages[0].rect.width).toBe(1000)
    expect(pages[0].rect.x).toBeCloseTo((EXPORT_MARGIN + 0.003) * 1000)
  })

  it('a board wider than a page goes on several, and skips the empty ones', () => {
    // Far left and far right, nothing between: 4 columns at 100%, the middle two empty
    const strokes = [stroke('a', [[0, 0], [0.1, 0.1]]), stroke('b', [[6, 0], [6.1, 0.1]])]
    const pages = boardPages(strokes, paddedBounds(strokesBounds(strokes)!))
    expect(pages).toHaveLength(2)
    expect(pages.every((page) => page.size === PAGE_SIZE)).toBe(true)
    expect(pages[0].rect.x).toBeGreaterThan(pages[1].rect.x)
  })

  it('a board drawn far apart gets smaller, never past the page limit', () => {
    const strokes: Stroke[] = []
    for (let x = -900; x <= 900; x += 100) {
      for (let y = -900; y <= 900; y += 100) strokes.push(stroke(`${x},${y}`, [[x, y]]))
    }
    const pages = boardPages(strokes, paddedBounds(strokesBounds(strokes)!))
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.length).toBeLessThanOrEqual(MAX_PDF_PAGES)
  })

  it('a PNG of everything stays what a browser can draw', () => {
    const small = wholeBoardPicture({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.25 })
    expect(small.size).toEqual({ width: 500, height: 250 })
    expect(small.rect.width).toBe(1000)
    const huge = wholeBoardPicture({ minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 })
    expect(huge.size.width).toBeLessThanOrEqual(MAX_EXPORT_SIDE)
    expect(huge.size.width * huge.size.height).toBeLessThanOrEqual(MAX_EXPORT_AREA * 1.01)
    const long = wholeBoardPicture({ minX: 0, minY: 0, maxX: 100, maxY: 0.1 })
    expect(long.size.width).toBeLessThanOrEqual(MAX_EXPORT_SIDE)
    expect(long.size.height).toBeGreaterThanOrEqual(1)
  })

  it('a share is drawn at its real size, unless that is too much', () => {
    expect(shareFrameSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 })
    const big = shareFrameSize({ width: 7680, height: 4320 })
    expect(big.width).toBeLessThanOrEqual(MAX_EXPORT_SIDE)
    expect(big.height / big.width).toBeCloseTo(4320 / 7680, 2)
  })
})

describe('the drawing, with a stand-in canvas (its pixels are the e2e tests)', () => {
  afterEach(() => vi.restoreAllMocks())

  function standInCanvas() {
    const made: HTMLCanvasElement[] = []
    const types: string[] = []
    const calls: string[] = []
    const ctx = new Proxy(
      {},
      {
        get: (_, name) => (name === 'measureText' ? () => ({ width: 0 }) : (...args: unknown[]) => {
          calls.push(String(name))
          return args.length < 0 ? undefined : undefined
        }),
        set: () => true,
      },
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ctx as unknown as null,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      done: BlobCallback,
      type?: string,
    ) {
      made.push(this)
      types.push(type ?? '')
      done(new Blob([fakeJpeg(1) as BlobPart], { type }))
    })
    return { made, types, calls }
  }

  const strokes = [stroke('a', [[0, 0], [0.5, 0.25]])]

  it('what is on screen, at the screen\'s pixel ratio, as PNG', async () => {
    const { made, types } = standInCanvas()
    const blob = await boardViewPng(strokes, { width: 400, height: 300 }, { x: 0, y: 0, width: 1000, height: 1000 }, 2)
    expect(blob.type).toBe('image/png')
    expect([made[0].width, made[0].height]).toEqual([800, 600])
    expect(types).toEqual(['image/png'])
  })

  it('everything as PNG; an empty board is an empty sheet, not an error', async () => {
    const { made } = standInCanvas()
    await boardWholePng(strokes)
    expect(made[0].width).toBeGreaterThan(500)
    await boardWholePng([])
    expect(made[1].width).toBeGreaterThan(0)
  })

  it('everything as a PDF of JPEGs, sharper than the screen', async () => {
    const { made, types } = standInCanvas()
    const pdf = await boardPdf(strokes, 'x')
    expect(pdf.type).toBe('application/pdf')
    expect(types).toEqual(['image/jpeg'])
    expect(made[0].width).toBeGreaterThan(500 * PAGE_PIXEL_RATIO)
    const { objects } = readPdf(new Uint8Array(await pdf.arrayBuffer()))
    expect(objects.get(6)).toContain(`/Width ${made[0].width} /Height ${made[0].height}`)
  })

  it('refuses honestly when the browser cannot encode', async () => {
    standInCanvas()
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((done: BlobCallback) => done(null))
    await expect(boardWholePng(strokes)).rejects.toThrow()
  })

  it('a share frame has the video when it should, and only the marks when its picture is hidden', () => {
    const { calls } = standInCanvas()
    const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement
    const frame = drawShareFrame(video, strokes, true)
    expect([frame.width, frame.height]).toEqual([1280, 720])
    // The picture, then the marks on top
    expect(calls.filter((name) => name === 'drawImage')).toHaveLength(2)
    calls.length = 0
    drawShareFrame(video, strokes, false)
    expect(calls.filter((name) => name === 'drawImage')).toHaveLength(1)
  })
})
