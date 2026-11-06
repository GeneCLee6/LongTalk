import { describe, expect, it } from 'vitest'
import { ANNOTATION_FRAME_CHARS, LASER_FADE_MS } from '../../shared/annotation-limits.ts'
import {
  ANNOTATION_COLORS,
  MAX_ANNOTATION_TEXT_CHARS,
  MAX_STROKES,
  MAX_STROKE_ID_CHARS,
  MAX_STROKE_POINTS,
  applyStrokeUpdate,
  beginStroke,
  clearStrokes,
  extendStroke,
  finishStroke,
  laserOpacity,
  lastStrokeBy,
  lineWidthRatio,
  newStrokeId,
  normalizeAnnotationText,
  normalizePoint,
  parseAnnotationOps,
  parseStroke,
  putStroke,
  removeStroke,
  simplifyPoints,
  strokeAt,
  strokeDistance,
  textBounds,
  type NormPoint,
  type Stroke,
} from '../../shared/annotation.ts'
import { MAX_CLIENT_MESSAGE_CHARS, parseClientMessage } from '../../shared/protocol.ts'
import { annotation } from '../../src/styles/tokens.ts'

const WIDE = 16 / 9

const pen = (points: NormPoint[], extra: Partial<Stroke> = {}): Stroke => ({
  id: 's',
  by: 'a',
  tool: 'pen',
  color: 'rose',
  width: 'medium',
  points,
  ...extra,
})

describe('points', () => {
  it('keeps a point on the picture, at 4 decimals', () => {
    expect(normalizePoint(0.123456, 0.5)).toEqual([0.1235, 0.5])
    expect(normalizePoint(-0.5, 1.5)).toEqual([0, 1])
    expect(normalizePoint(Number.NaN, 0)).toBeNull()
    expect(normalizePoint(0, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('simplifyPoints', () => {
  it('drops points on a straight line, keeps the ends', () => {
    const line: NormPoint[] = Array.from({ length: 100 }, (_, i) => [i / 99, 0.5])
    expect(simplifyPoints(line, WIDE)).toEqual([line[0], line[99]])
  })

  it('keeps a corner', () => {
    const corner: NormPoint[] = [
      [0, 0],
      [0.25, 0],
      [0.5, 0],
      [0.5, 0.25],
      [0.5, 0.5],
    ]
    expect(simplifyPoints(corner, 1)).toEqual([
      [0, 0],
      [0.5, 0],
      [0.5, 0.5],
    ])
  })

  it('stays within the tolerance of the original path', () => {
    const wave: NormPoint[] = Array.from({ length: 500 }, (_, i) => [
      i / 499,
      0.5 + 0.2 * Math.sin((i / 499) * Math.PI * 4),
    ])
    const tolerance = 0.002
    const simplified = simplifyPoints(wave, WIDE, tolerance)
    expect(simplified.length).toBeLessThan(wave.length / 3)
    for (const point of wave) {
      const stroke = pen(simplified, { width: 'thin' })
      expect(strokeDistance(stroke, point, WIDE)).toBeLessThanOrEqual(tolerance + 1e-9)
    }
  })

  it('measures in real distance: x counts for more on a wide picture', () => {
    // A bump of 0.002 across is 0.0036 picture heights at 16:9, but only 0.002 at 1:1
    const bump: NormPoint[] = [
      [0.5, 0],
      [0.502, 0.5],
      [0.5, 1],
    ]
    expect(simplifyPoints(bump, 1, 0.003)).toHaveLength(2)
    expect(simplifyPoints(bump, WIDE, 0.003)).toHaveLength(3)
  })

  it('leaves one or two points alone, and survives a very long path', () => {
    expect(simplifyPoints([[0.1, 0.1]], WIDE)).toHaveLength(1)
    expect(simplifyPoints([], WIDE)).toEqual([])
    const long: NormPoint[] = Array.from({ length: 50_000 }, (_, i) => [
      (i % 1000) / 1000,
      i / 50_000,
    ])
    expect(simplifyPoints(long, WIDE).length).toBeGreaterThan(2)
  })
})

describe('drawing a stroke', () => {
  const begin = (tool: Stroke['tool'], extra: { text?: string } = {}) =>
    beginStroke({ id: 's', by: 'a', tool, at: { x: 0.1, y: 0.1 }, ...extra })!

  it('a pen starts at one point with the default colour and width', () => {
    expect(begin('pen')).toEqual({
      id: 's',
      by: 'a',
      tool: 'pen',
      color: 'rose',
      width: 'medium',
      points: [[0.1, 0.1]],
    })
  })

  it('a bad start is no stroke', () => {
    expect(beginStroke({ by: 'a', tool: 'pen', at: { x: Number.NaN, y: 0 } })).toBeNull()
  })

  it('a path grows, keeping points on the picture, without points too close to the last', () => {
    let stroke = begin('pen')
    stroke = extendStroke(stroke, { x: 0.2, y: 0.2 }, WIDE)
    expect(stroke.points).toHaveLength(2)
    expect(extendStroke(stroke, { x: 0.2001, y: 0.2 }, WIDE)).toBe(stroke)
    expect(extendStroke(stroke, { x: 1.5, y: -1 }, WIDE).points[2]).toEqual([1, 0])
  })

  it('does not change the stroke it was given', () => {
    const stroke = begin('pen')
    extendStroke(stroke, { x: 0.5, y: 0.5 }, WIDE)
    expect(stroke.points).toHaveLength(1)
  })

  it('drawing forever keeps within the point limit and still reaches the pointer', () => {
    let stroke = begin('pen')
    let most = 0
    const COUNT = 5_000
    for (let i = 0; i < COUNT; i++) {
      const t = i / COUNT
      stroke = extendStroke(
        stroke,
        { x: 0.5 + 0.4 * t * Math.cos(i / 10), y: 0.5 + 0.4 * t * Math.sin(i / 10) },
        WIDE,
      )
      most = Math.max(most, stroke.points.length)
    }
    expect(most).toBeGreaterThan(MAX_STROKE_POINTS / 2)
    expect(most).toBeLessThanOrEqual(MAX_STROKE_POINTS)
    const t = (COUNT - 1) / COUNT
    const last = stroke.points[stroke.points.length - 1]
    expect(last[0]).toBeCloseTo(0.5 + 0.4 * t * Math.cos((COUNT - 1) / 10), 3)
    expect(stroke.points[0]).toEqual([0.1, 0.1])
  })

  it('an arrow or rectangle moves its second point', () => {
    for (const tool of ['arrow', 'rect'] as const) {
      const stroke = extendStroke(
        extendStroke(begin(tool), { x: 0.3, y: 0.3 }, WIDE),
        { x: 0.4, y: 0.2 },
        WIDE,
      )
      expect(stroke.points).toEqual([
        [0.1, 0.1],
        [0.4, 0.2],
      ])
    }
  })

  it('a text mark stays where it was put', () => {
    const stroke = begin('text', { text: 'hi' })
    expect(extendStroke(stroke, { x: 0.9, y: 0.9 }, WIDE)).toBe(stroke)
  })

  it('finishing simplifies a path; a tap stays a dot', () => {
    let stroke = begin('pen')
    for (let i = 1; i <= 50; i++) stroke = extendStroke(stroke, { x: 0.1 + i / 100, y: 0.1 }, WIDE)
    expect(finishStroke(stroke, WIDE)?.points).toHaveLength(2)
    expect(finishStroke(begin('pen'), WIDE)?.points).toEqual([[0.1, 0.1]])
  })

  it('an arrow or rectangle with no size, or empty text, comes to nothing', () => {
    expect(finishStroke(begin('arrow'), WIDE)).toBeNull()
    expect(finishStroke(begin('rect'), WIDE)).toBeNull()
    expect(finishStroke(begin('text', { text: '  ' }), WIDE)).toBeNull()
    expect(finishStroke(begin('text', { text: ' 小潔 ' }), WIDE)?.text).toBe('小潔')
  })

  it('ids are different', () => {
    expect(newStrokeId()).not.toBe(newStrokeId())
    expect(newStrokeId().length).toBeLessThanOrEqual(MAX_STROKE_ID_CHARS)
  })
})

describe('limits', () => {
  it('the largest stroke fits one client message (J2 sends it whole)', () => {
    const points = Array.from({ length: MAX_STROKE_POINTS }, (): NormPoint => [0.1234, 0.5678])
    const stroke = pen(points, {
      id: 'x'.repeat(MAX_STROKE_ID_CHARS),
      by: 'y'.repeat(MAX_STROKE_ID_CHARS),
    })
    expect(JSON.stringify({ t: 'annotation.add', stroke }).length).toBeLessThan(
      MAX_CLIENT_MESSAGE_CHARS,
    )
  })

  it('the longest text mark fits too, even all quotes', () => {
    const stroke = pen([[0.1, 0.1]], { tool: 'text', text: '"'.repeat(MAX_ANNOTATION_TEXT_CHARS) })
    expect(JSON.stringify(stroke).length).toBeLessThan(MAX_CLIENT_MESSAGE_CHARS)
  })

  it('text is cleaned like chat, and has its own length limit', () => {
    expect(normalizeAnnotationText(`a‮b`)).toBe('ab')
    expect(normalizeAnnotationText('x'.repeat(MAX_ANNOTATION_TEXT_CHARS))).toHaveLength(
      MAX_ANNOTATION_TEXT_CHARS,
    )
    expect(normalizeAnnotationText('x'.repeat(MAX_ANNOTATION_TEXT_CHARS + 1))).toBeNull()
    expect(normalizeAnnotationText(42)).toBeNull()
  })
})

describe('parseStroke (what RoomDO accepts, J2)', () => {
  const good = pen([
    [0.1, 0.2],
    [0.3, 0.4],
  ])

  it('accepts a good one, and drops anything extra', () => {
    expect(parseStroke({ ...good, evil: true })).toEqual(good)
  })

  it('rounds points to the stored precision', () => {
    expect(parseStroke({ ...good, points: [[0.123456, 0.5]] })?.points).toEqual([[0.1235, 0.5]])
  })

  const bad: [string, unknown][] = [
    ['not an object', 'x'],
    ['null', null],
    ['no id', { ...good, id: '' }],
    ['a long id', { ...good, id: 'x'.repeat(MAX_STROKE_ID_CHARS + 1) }],
    ['no author', { ...good, by: 1 }],
    ['an unknown tool', { ...good, tool: 'flamethrower' }],
    ['an unknown colour', { ...good, color: '#ff0000' }],
    ['an unknown width', { ...good, width: 99 }],
    ['no points', { ...good, points: [] }],
    ['points not a list', { ...good, points: 'x' }],
    ['a point off the picture', { ...good, points: [[1.1, 0]] }],
    ['a point not a number', { ...good, points: [['0', 0]] }],
    ['a NaN', { ...good, points: [[Number.NaN, 0]] }],
    ['a point with three numbers', { ...good, points: [[0, 0, 0]] }],
    ['too many points', { ...good, points: Array(MAX_STROKE_POINTS + 1).fill([0, 0]) }],
    [
      'an arrow with three',
      {
        ...good,
        tool: 'arrow',
        points: [
          [0, 0],
          [0, 1],
          [1, 1],
        ],
      },
    ],
    ['a rectangle with one', { ...good, tool: 'rect', points: [[0, 0]] }],
    ['text with two points', { ...good, tool: 'text', text: 'x' }],
    ['text with no text', { ...good, tool: 'text', points: [[0, 0]] }],
  ]
  for (const [name, stroke] of bad) {
    it(`refuses ${name}`, () => {
      expect(parseStroke(stroke)).toBeNull()
    })
  }

  it('accepts text, cleaned', () => {
    expect(parseStroke({ ...good, tool: 'text', points: [[0.1, 0.1]], text: ' 小潔 ' })?.text).toBe(
      '小潔',
    )
  })
})

describe('the list', () => {
  const a = pen([[0, 0]], { id: 'a', by: 'm1' })
  const b = pen([[1, 1]], { id: 'b', by: 'm2' })
  const c = pen([[0.5, 0.5]], { id: 'c', by: 'm1' })

  it('adds at the end, replaces in place', () => {
    const list = putStroke(putStroke([], a), b)
    expect(list.map((s) => s.id)).toEqual(['a', 'b'])
    const moved = { ...a, points: [[0.2, 0.2]] as NormPoint[] }
    const updated = putStroke(list, moved)
    expect(updated.map((s) => s.id)).toEqual(['a', 'b'])
    expect(updated[0]).toBe(moved)
    expect(list[0]).toBe(a)
  })

  it('past the limit the oldest goes', () => {
    const full = Array.from({ length: MAX_STROKES }, (_, i) => pen([[0, 0]], { id: `s${i}` }))
    const next = putStroke(full, pen([[0, 0]], { id: 'new' }))
    expect(next).toHaveLength(MAX_STROKES)
    expect(next[0].id).toBe('s1')
    expect(next[next.length - 1].id).toBe('new')
  })

  it('removes one, clears all or one member', () => {
    const list = [a, b, c]
    expect(removeStroke(list, 'b').map((s) => s.id)).toEqual(['a', 'c'])
    expect(clearStrokes(list)).toEqual([])
    expect(clearStrokes(list, 'm1').map((s) => s.id)).toEqual(['b'])
  })

  it('finds the member’s latest for undo', () => {
    expect(lastStrokeBy([a, b, c], 'm1')).toBe(c)
    expect(lastStrokeBy([a, b, c], 'm2')).toBe(b)
    expect(lastStrokeBy([a, b, c], 'm3')).toBeNull()
  })
})

describe('hit-testing', () => {
  const line = pen(
    [
      [0.2, 0.5],
      [0.8, 0.5],
    ],
    { id: 'line' },
  )

  it('on the line, and near it', () => {
    expect(strokeDistance(line, [0.5, 0.5], WIDE)).toBe(0)
    expect(strokeAt([line], [0.5, 0.505], WIDE)?.id).toBe('line')
    expect(strokeAt([line], [0.5, 0.6], WIDE)).toBeNull()
  })

  it('past the end counts the distance to the end, in real distance', () => {
    // 0.1 across on a 16:9 picture is 0.178 picture heights
    const away = strokeDistance(line, [0.9, 0.5], WIDE) + (lineWidthRatio(line) * 1) / 2
    expect(away).toBeCloseTo(0.1 * WIDE)
  })

  it('a thick stroke is easier to hit, a highlighter more so', () => {
    const point: NormPoint = [0.5, 0.51]
    const thin = strokeDistance({ ...line, width: 'thin' }, point, WIDE)
    const thick = strokeDistance({ ...line, width: 'thick' }, point, WIDE)
    const highlighter = strokeDistance({ ...line, tool: 'highlighter' }, point, WIDE)
    expect(thick).toBeLessThan(thin)
    expect(highlighter).toBeLessThan(strokeDistance(line, point, WIDE))
  })

  it('the newest stroke on top wins', () => {
    const newer = { ...line, id: 'newer' }
    expect(strokeAt([line, newer], [0.5, 0.5], WIDE)?.id).toBe('newer')
  })

  it('a dot', () => {
    const dot = pen([[0.5, 0.5]])
    expect(strokeAt([dot], [0.5, 0.505], WIDE)).toBe(dot)
    expect(strokeAt([dot], [0.6, 0.5], WIDE)).toBeNull()
  })

  it('a rectangle is its outline, not its inside', () => {
    const rect = pen(
      [
        [0.2, 0.2],
        [0.8, 0.8],
      ],
      { tool: 'rect' },
    )
    expect(strokeAt([rect], [0.2, 0.5], WIDE)).toBe(rect)
    expect(strokeAt([rect], [0.5, 0.8], WIDE)).toBe(rect)
    expect(strokeAt([rect], [0.5, 0.5], WIDE)).toBeNull()
  })

  it('an arrow is its line', () => {
    const arrow = pen(
      [
        [0.2, 0.2],
        [0.8, 0.8],
      ],
      { tool: 'arrow' },
    )
    expect(strokeAt([arrow], [0.5, 0.5], 1)).toBe(arrow)
    expect(strokeAt([arrow], [0.2, 0.8], 1)).toBeNull()
  })

  it('a text mark is its box, wider for wide characters', () => {
    const latin = pen([[0.1, 0.1]], { tool: 'text', text: 'hello' })
    const cjk = pen([[0.1, 0.1]], { tool: 'text', text: '泡湯改時間' })
    expect(textBounds(cjk, WIDE).width).toBeGreaterThan(textBounds(latin, WIDE).width)
    const box = textBounds(cjk, WIDE)
    expect(strokeAt([cjk], [box.x + box.width / 2, box.y + box.height / 2], WIDE)).toBe(cjk)
    expect(strokeAt([cjk], [0.9, 0.9], WIDE)).toBeNull()
    const lines = pen([[0.1, 0.1]], { tool: 'text', text: 'a\nb\nc' })
    expect(textBounds(lines, WIDE).height).toBeCloseTo(textBounds(latin, WIDE).height * 3)
  })
})

describe('the palette', () => {
  it('every colour has a value in the tokens (eight, PRD E7)', () => {
    expect(ANNOTATION_COLORS).toHaveLength(8)
    for (const name of ANNOTATION_COLORS) {
      expect(annotation.colors[name]).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  it('has a dark and a light choice, for white documents and dark terminals', () => {
    expect(annotation.colors.ink).not.toBe(annotation.colors.white)
  })
})

describe('the wire (J2)', () => {
  const pen = {
    id: 's',
    by: 'forged',
    tool: 'pen',
    color: 'rose',
    width: 'thin',
    points: [[0.1, 0.1]],
  }

  it('parses each op, leaving `by` for the room to stamp', () => {
    expect(
      parseAnnotationOps([
        { op: 'add', stroke: pen, live: true, extra: 1 },
        { op: 'update', id: 's', at: 1, points: [[0.2, 0.2]] },
        { op: 'remove', id: 's' },
        { op: 'clear', by: 'someone' },
        { op: 'laser', at: [0.5, 0.5], color: 'amber' },
        { op: 'laser', at: null, color: 'amber' },
      ]),
    ).toEqual([
      { op: 'add', stroke: { ...pen, by: '' }, live: true },
      { op: 'update', id: 's', at: 1, points: [[0.2, 0.2]] },
      { op: 'remove', id: 's' },
      // Clearing someone else's is J3's: what a browser asks for is only ever its own
      { op: 'clear' },
      { op: 'laser', at: [0.5, 0.5], color: 'amber' },
      { op: 'laser', at: null, color: 'amber' },
    ])
  })

  it('refuses anything else, whole', () => {
    for (const ops of [
      null,
      'x',
      [],
      [{ op: 'nope' }],
      [{ op: 'add' }],
      [{ op: 'add', stroke: null }],
      [{ op: 'add', stroke: { ...pen, id: 'x'.repeat(MAX_STROKE_ID_CHARS + 1) } }],
      [{ op: 'update', id: '', at: 0, points: [[0, 0]] }],
      [{ op: 'update', id: 's', at: 0.5, points: [[0, 0]] }],
      [{ op: 'update', id: 's', at: 0, points: [] }],
      [{ op: 'update', id: 's', at: 0, points: [[2, 0]] }],
      [{ op: 'remove' }],
      [{ op: 'laser', at: [0.5, 0.5], color: 'pink' }],
      [{ op: 'clear' }, 7],
      Array.from({ length: 33 }, () => ({ op: 'clear' })),
    ]) {
      expect(parseAnnotationOps(ops)).toBeNull()
    }
  })

  it('applies an update: appended, a head moved, or thinned from the start', () => {
    const stroke = parseStroke({ ...pen, points: [[0.1, 0.1], [0.2, 0.2]] })!
    expect(applyStrokeUpdate(stroke, 2, [[0.3, 0.3]])?.points).toEqual([
      [0.1, 0.1],
      [0.2, 0.2],
      [0.3, 0.3],
    ])
    expect(applyStrokeUpdate(stroke, 0, [[0.9, 0.9]])?.points).toEqual([[0.9, 0.9]])
    expect(applyStrokeUpdate(stroke, 3, [[0.3, 0.3]])).toBeNull()
    const arrow = { ...stroke, tool: 'arrow' as const }
    expect(applyStrokeUpdate(arrow, 1, [[0.5, 0.5]])?.points).toEqual([
      [0.1, 0.1],
      [0.5, 0.5],
    ])
    expect(applyStrokeUpdate(arrow, 2, [[0.5, 0.5]])).toBeNull()
    expect(applyStrokeUpdate({ ...stroke, tool: 'text', text: 'x' }, 0, [[0.5, 0.5]])).toBeNull()
  })

  it('a whole stroke at the point limit fits one client frame', () => {
    const points = Array.from({ length: MAX_STROKE_POINTS }, () => [0.1234, 0.5678])
    const frame = JSON.stringify({
      t: 'annotate',
      share: 'x'.repeat(36),
      ops: [{ op: 'add', stroke: { ...pen, id: 'x'.repeat(MAX_STROKE_ID_CHARS), points } }],
    })
    expect(frame.length).toBeLessThan(ANNOTATION_FRAME_CHARS)
    expect(ANNOTATION_FRAME_CHARS).toBeLessThan(MAX_CLIENT_MESSAGE_CHARS)
    expect(parseClientMessage(frame)).not.toBeNull()
  })

  it('a laser fades from 1 to 0 over LASER_FADE_MS', () => {
    expect(laserOpacity(1000, 1000)).toBe(1)
    expect(laserOpacity(1000, 1000 + LASER_FADE_MS / 2)).toBeCloseTo(0.5)
    expect(laserOpacity(1000, 1000 + LASER_FADE_MS)).toBe(0)
    expect(laserOpacity(1000, 1000 + LASER_FADE_MS * 2)).toBe(0)
  })
})
