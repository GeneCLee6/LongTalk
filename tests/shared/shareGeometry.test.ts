import { describe, expect, it } from 'vitest'
import {
  FIT_VIEW,
  MAX_ZOOM,
  backingSize,
  clampView,
  containRect,
  contentRect,
  contentToDevice,
  contentToTile,
  deviceToContent,
  insideContent,
  panBy,
  tileToContent,
  videoTransform,
  wheelZoomFactor,
  zoomAt,
  type ShareView,
  type Size,
} from '../../shared/shareGeometry.ts'

const box: Size = { width: 1000, height: 1000 }
const wide: Size = { width: 1920, height: 1080 }
const tall: Size = { width: 720, height: 1280 }

describe('containRect (object-fit: contain)', () => {
  it('letterboxes a wide picture in a square tile: bars above and below', () => {
    const rect = containRect(box, wide)!
    expect(rect.x).toBe(0)
    expect(rect.width).toBe(1000)
    expect(rect.height).toBeCloseTo(562.5)
    expect(rect.y).toBeCloseTo(218.75)
  })

  it('a tall picture: bars at the sides', () => {
    const rect = containRect(box, tall)!
    expect(rect.y).toBe(0)
    expect(rect.height).toBe(1000)
    expect(rect.width).toBeCloseTo(562.5)
    expect(rect.x).toBeCloseTo(218.75)
  })

  it('the same shape fills the tile', () => {
    expect(containRect({ width: 1920, height: 1080 }, { width: 960, height: 540 })).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    })
  })

  it('nothing before there is a picture or a tile', () => {
    expect(containRect(box, null)).toBeNull()
    expect(containRect(box, { width: 0, height: 0 })).toBeNull()
    expect(containRect({ width: 0, height: 0 }, wide)).toBeNull()
    expect(contentRect(box, null)).toBeNull()
  })
})

describe('the view', () => {
  it('keeps the zoom within bounds, and a hair above 100% is 100%', () => {
    expect(clampView(box, wide, { ...FIT_VIEW, zoom: 0.2 }).zoom).toBe(1)
    expect(clampView(box, wide, { ...FIT_VIEW, zoom: 1.004 }).zoom).toBe(1)
    expect(clampView(box, wide, { ...FIT_VIEW, zoom: 99 }).zoom).toBe(MAX_ZOOM)
    expect(clampView(box, wide, { ...FIT_VIEW, zoom: Number.NaN }).zoom).toBe(1)
  })

  it('a picture smaller than the tile stays centred, however it was panned', () => {
    expect(clampView(box, wide, { zoom: 1, cx: 0.1, cy: 0.9 })).toEqual(FIT_VIEW)
  })

  it('a zoomed picture leaves no gap it could fill', () => {
    // 3× a 1000 × 562.5 picture: 3000 × 1687.5 in a 1000 tile
    const view = clampView(box, wide, { zoom: 3, cx: 0, cy: 1 })
    const rect = contentRect(box, wide, view)!
    expect(rect.x).toBeCloseTo(0)
    expect(rect.y + rect.height).toBeCloseTo(1000)
  })

  it('at a zoom filling one axis only, the other stays centred', () => {
    // 1.5×: 1500 × 843.75 fits vertically in the tile, not horizontally
    const view = clampView(box, wide, { zoom: 1.5, cx: 0.1, cy: 0.1 })
    expect(view.cy).toBe(0.5)
    expect(view.cx).toBeCloseTo(1000 / (2 * 1500))
  })

  it('zooming holds the point under the pointer', () => {
    const anchor = { x: 700, y: 600 }
    const before = contentRect(box, wide, clampView(box, wide, { zoom: 2, cx: 0.5, cy: 0.5 }))!
    const held = tileToContent(before, anchor)
    const after = contentRect(
      box,
      wide,
      zoomAt(box, wide, { zoom: 2, cx: 0.5, cy: 0.5 }, 3, anchor),
    )!
    const now = contentToTile(after, held)
    expect(now.x).toBeCloseTo(anchor.x)
    expect(now.y).toBeCloseTo(anchor.y)
  })

  it('zooming at 100% from a corner is held back by the edges, then undone by zooming out', () => {
    const zoomed = zoomAt(box, wide, FIT_VIEW, 2, { x: 0, y: 500 })
    expect(zoomed.zoom).toBe(2)
    const rect = contentRect(box, wide, zoomed)!
    expect(rect.x).toBeCloseTo(0)
    expect(zoomAt(box, wide, zoomed, 1)).toEqual(FIT_VIEW)
  })

  it('panning moves the picture by as many pixels, up to its edge', () => {
    const start = clampView(box, wide, { zoom: 2, cx: 0.5, cy: 0.5 })
    const before = contentRect(box, wide, start)!
    const moved = contentRect(box, wide, panBy(box, wide, start, 100, 50))!
    expect(moved.x - before.x).toBeCloseTo(100)
    expect(moved.y - before.y).toBeCloseTo(50)
    const far = contentRect(box, wide, panBy(box, wide, start, 99_999, 0))!
    expect(far.x).toBeCloseTo(0)
  })

  it('at 100% panning does nothing', () => {
    expect(panBy(box, wide, FIT_VIEW, 500, 500)).toEqual(FIT_VIEW)
  })

  it('a resize keeps the same content in the middle', () => {
    const view: ShareView = { zoom: 3, cx: 0.4, cy: 0.6 }
    for (const size of [box, { width: 1600, height: 900 }, { width: 500, height: 600 }]) {
      const rect = contentRect(size, wide, view)!
      const middle = tileToContent(rect, { x: size.width / 2, y: size.height / 2 })
      expect(middle.x).toBeCloseTo(0.4)
      expect(middle.y).toBeCloseTo(0.6)
    }
  })

  it('a lower simulcast layer of the same picture changes nothing', () => {
    const view: ShareView = { zoom: 2, cx: 0.4, cy: 0.5 }
    expect(contentRect(box, { width: 960, height: 540 }, view)).toEqual(
      contentRect(box, wide, view),
    )
  })
})

describe('mapping there and back', () => {
  const sizes: Size[] = [
    { width: 1000, height: 1000 },
    { width: 1920, height: 1080 },
    { width: 390, height: 300 },
    { width: 333.5, height: 777.25 },
  ]
  const sources: Size[] = [wide, tall, { width: 2560, height: 1080 }, { width: 800, height: 800 }]
  const views: ShareView[] = [
    FIT_VIEW,
    { zoom: 1.5, cx: 0.3, cy: 0.7 },
    { zoom: 4, cx: 0.9, cy: 0.1 },
  ]
  const ratios = [1, 1.25, 1.5, 2, 3]
  const points = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 0.25, y: 0.75 },
    { x: 0.123, y: 0.987 },
  ]

  it('content → tile → content and content → device → content, everywhere', () => {
    for (const size of sizes) {
      for (const source of sources) {
        for (const view of views) {
          const rect = contentRect(size, source, view)!
          for (const point of points) {
            const tile = tileToContent(rect, contentToTile(rect, point))
            expect(tile.x).toBeCloseTo(point.x, 9)
            expect(tile.y).toBeCloseTo(point.y, 9)
            for (const ratio of ratios) {
              const back = deviceToContent(rect, ratio, contentToDevice(rect, ratio, point))
              expect(back.x).toBeCloseTo(point.x, 9)
              expect(back.y).toBeCloseTo(point.y, 9)
            }
          }
        }
      }
    }
  })

  it('the picture corners land on the letterboxed rectangle', () => {
    const rect = containRect(box, wide)!
    expect(contentToTile(rect, { x: 0, y: 0 })).toEqual({ x: rect.x, y: rect.y })
    expect(contentToTile(rect, { x: 1, y: 1 })).toEqual({
      x: rect.x + rect.width,
      y: rect.y + rect.height,
    })
  })

  it('device pixels are tile pixels times the ratio', () => {
    const rect = containRect(box, wide)!
    const device = contentToDevice(rect, 2, { x: 0.5, y: 0.5 })
    expect(device.x).toBeCloseTo(1000)
    expect(device.y).toBeCloseTo(1000)
  })

  it('a bad pixel ratio counts as 1', () => {
    const rect = containRect(box, wide)!
    expect(contentToDevice(rect, 0, { x: 1, y: 0 }).x).toBe(1000)
    expect(contentToDevice(rect, Number.NaN, { x: 1, y: 0 }).x).toBe(1000)
  })

  it('points on the letterbox bars are outside the picture', () => {
    const rect = containRect(box, wide)!
    expect(insideContent(tileToContent(rect, { x: 500, y: 100 }))).toBe(false)
    expect(insideContent(tileToContent(rect, { x: 500, y: 500 }))).toBe(true)
  })
})

describe('the canvas and the video', () => {
  it('backing store: whole device pixels, at least one', () => {
    expect(backingSize({ width: 333.5, height: 200 }, 2)).toEqual({ width: 667, height: 400 })
    expect(backingSize({ width: 0, height: 0 }, 2)).toEqual({ width: 1, height: 1 })
  })

  it('no transform at 100% or before there is a picture', () => {
    expect(videoTransform(box, wide, FIT_VIEW)).toBe('none')
    expect(videoTransform(box, null, { zoom: 2, cx: 0.5, cy: 0.5 })).toBe('none')
  })

  it('the transform puts the picture exactly where contentRect says', () => {
    const view: ShareView = { zoom: 2, cx: 0.3, cy: 0.5 }
    const transform = videoTransform(box, wide, view)
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(2\)/.exec(transform)!
    const fit = containRect(box, wide)!
    const rect = contentRect(box, wide, view)!
    // The <video> scales around the tile's centre, then moves
    const scaledX = box.width / 2 - (box.width / 2 - fit.x) * 2 + Number(match[1])
    const scaledY = box.height / 2 - (box.height / 2 - fit.y) * 2 + Number(match[2])
    expect(scaledX).toBeCloseTo(rect.x)
    expect(scaledY).toBeCloseTo(rect.y)
  })
})

describe('wheelZoomFactor', () => {
  it('up zooms in, down zooms out, by the same factor', () => {
    const inward = wheelZoomFactor(-100, 0, false)
    expect(inward).toBeGreaterThan(1)
    expect(inward * wheelZoomFactor(100, 0, false)).toBeCloseTo(1)
  })

  it('lines and pages count for more than pixels; a pinch is faster', () => {
    expect(wheelZoomFactor(-3, 1, false)).toBeGreaterThan(wheelZoomFactor(-3, 0, false))
    expect(wheelZoomFactor(-1, 2, false)).toBeGreaterThan(wheelZoomFactor(-1, 1, false))
    expect(wheelZoomFactor(-10, 0, true)).toBeGreaterThan(wheelZoomFactor(-10, 0, false))
  })
})
