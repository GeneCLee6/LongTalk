import { describe, expect, it } from 'vitest'
import {
  chooseLayers,
  clampLayer,
  devicePixels,
  DOWNLINK_BUDGET_BPS,
  layerForSize,
  shownShortSide,
  type LayerInput,
  type VideoDemand,
} from '../../../src/media/layers.ts'
import { SIMULCAST } from '../../../src/media/encoding.ts'

const tile = (width: number, height: number, visible = true, aspect: number | null = 16 / 9) =>
  ({ width, height, visible, aspect }) satisfies VideoDemand

const cam = (key: string, demand: VideoDemand | null, current: LayerInput['current'] = null) =>
  ({ key, kind: 'cam', demand, current }) satisfies LayerInput

describe('layer by tile size (e2-t12)', () => {
  it('asks for the smallest camera layer that is good enough for the drawn size', () => {
    // A strip tile, a grid tile of eight on a laptop, the speaker's big tile
    expect(layerForSize('cam', tile(200, 112), null)).toBe('low')
    expect(layerForSize('cam', tile(410, 230), null)).toBe('medium')
    expect(layerForSize('cam', tile(1100, 620), null)).toBe('high')
  })

  it('counts what a cropped camera shows: a 4:3 tile of a 16:9 picture needs its width', () => {
    // cover: the picture is scaled to the tile's width / height, whichever is larger
    expect(shownShortSide('cam', tile(480, 360))).toBe(360)
    expect(shownShortSide('cam', tile(640, 200))).toBe(360)
    // A phone held upright sends a tall picture: the short side is its width
    expect(shownShortSide('cam', tile(400, 400, true, 9 / 16))).toBeCloseTo(400)
  })

  it('fits a screen inside its box (contain), with two layers: no low', () => {
    expect(shownShortSide('screen', tile(1600, 400))).toBe(400)
    expect(layerForSize('screen', tile(1400, 790), null)).toBe('high')
    expect(layerForSize('screen', tile(390, 220), null)).toBe('medium')
    expect(layerForSize('screen', null, null)).toBe('medium')
    expect(clampLayer('screen', 'low')).toBe('medium')
    expect(clampLayer('cam', 'low')).toBe('low')
  })

  it('gives the lowest layer to a video that is not drawn, or drawn nowhere', () => {
    expect(layerForSize('cam', tile(1100, 620, false), 'high')).toBe('low')
    expect(layerForSize('cam', null, 'high')).toBe('low')
    expect(layerForSize('cam', tile(0, 0), 'medium')).toBe('low')
  })

  it('keeps the current layer while the tile is within the hysteresis band', () => {
    // medium covers 360 lines; it is good enough up to 450 (360 / 0.8)
    expect(layerForSize('cam', tile(800, 440), 'medium')).toBe('medium')
    expect(layerForSize('cam', tile(820, 460), 'medium')).toBe('high')
    // Back down from high only once medium covers the tile fully (≤ 360 lines)
    expect(layerForSize('cam', tile(780, 420), 'high')).toBe('high')
    expect(layerForSize('cam', tile(700, 380), 'high')).toBe('high')
    expect(layerForSize('cam', tile(620, 350), 'high')).toBe('medium')
    // A tile resized back and forth around the boundary does not flip
    let layer = layerForSize('cam', tile(820, 460), null)
    for (const height of [440, 455, 430, 460, 400]) {
      layer = layerForSize('cam', tile(Math.round((height * 16) / 9), height), layer)
      expect(layer).toBe('high')
    }
  })

  it('counts device pixels, at most twice the CSS size', () => {
    expect(devicePixels(300, 1)).toBe(300)
    expect(devicePixels(300, 1.5)).toBe(450)
    expect(devicePixels(300, 3)).toBe(600)
    expect(devicePixels(300, Number.NaN)).toBe(300)
  })
})

describe('layers within the downlink budget (AC-2.6)', () => {
  const bitrate = (layers: Map<string, string>, inputs: LayerInput[]) =>
    inputs.reduce(
      (sum, input) =>
        sum + SIMULCAST[input.kind].find((l) => l.layer === layers.get(input.key))!.maxBitrate,
      0,
    )

  it('an 8-person grid on a laptop: seven medium tiles, well within budget', () => {
    const inputs = Array.from({ length: 7 }, (_, i) => cam(`c${i}`, tile(410, 230)))
    const layers = chooseLayers(inputs, DOWNLINK_BUDGET_BPS)
    expect([...layers.values()]).toEqual(Array(7).fill('medium'))
    expect(bitrate(layers, inputs)).toBeLessThanOrEqual(DOWNLINK_BUDGET_BPS)
  })

  it('a big screen wanting seven high cameras: equal tiles share the cut', () => {
    const inputs = Array.from({ length: 7 }, (_, i) => cam(`c${i}`, tile(900, 500)))
    const layers = chooseLayers(inputs, DOWNLINK_BUDGET_BPS)
    expect(bitrate(layers, inputs)).toBeLessThanOrEqual(DOWNLINK_BUDGET_BPS)
    // Every one down a step (2.8 Mbps), none down two
    expect([...layers.values()]).toEqual(Array(7).fill('medium'))
  })

  it('a bigger tile keeps more than smaller ones when the budget bites', () => {
    const inputs = [
      cam('big', tile(1300, 740)),
      ...Array.from({ length: 6 }, (_, i) => cam(`c${i}`, tile(700, 400))),
    ]
    const layers = chooseLayers(inputs, 2_400_000)
    expect(bitrate(layers, inputs)).toBeLessThanOrEqual(2_400_000)
    expect(layers.get('big')).toBe('high')
    expect([...layers.values()].filter((l) => l === 'low').length).toBeGreaterThan(0)
  })

  it('a share and a strip of cameras: the cameras give way before the screen', () => {
    const inputs: LayerInput[] = [
      { key: 'screen', kind: 'screen', demand: tile(1500, 840), current: null },
      ...Array.from({ length: 7 }, (_, i) => cam(`c${i}`, tile(560, 315))),
    ]
    const layers = chooseLayers(inputs, DOWNLINK_BUDGET_BPS)
    expect(layers.get('screen')).toBe('high')
    expect([...layers.values()].filter((l) => l === 'low')).toHaveLength(7)
    expect(bitrate(layers, inputs)).toBeLessThanOrEqual(DOWNLINK_BUDGET_BPS)
    // Only once every camera is as low as it goes does the screen give way
    expect(chooseLayers(inputs, 2_000_000).get('screen')).toBe('medium')
  })

  it('steps up only with headroom, so a full budget does not flap', () => {
    const budget = 2_000_000
    // Two cameras at medium (800 kbps); one wants high: 1.6 Mbps fits 2.0, not the headroom 1.7
    const inputs = [cam('a', tile(1100, 620), 'medium'), cam('b', tile(1100, 620), 'high')]
    const layers = chooseLayers(inputs, budget)
    expect(layers.get('b')).toBe('high')
    expect(layers.get('a')).toBe('medium')
    // A new subscription (no layer yet) is not an upgrade: it gets what fits
    expect(chooseLayers([cam('a', tile(1100, 620))], budget).get('a')).toBe('high')
  })

  it('goes no lower than every lowest layer however small the budget', () => {
    const inputs = [cam('a', tile(1100, 620)), cam('b', tile(1100, 620))]
    expect([...chooseLayers(inputs, 10).values()]).toEqual(['low', 'low'])
  })
})
