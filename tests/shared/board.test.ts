// J3 (e7-t05, e7-t06): the whiteboard's world (the model in another space, its geometry), its place
// among the shares, and the permission functions both ends read.
import { describe, expect, it } from 'vitest'
import {
  BOARD_SPACE,
  PICTURE_SPACE,
  WHITEBOARD_LAYER,
  applyStrokeUpdate,
  beginStroke,
  extendStroke,
  insideSpace,
  limitsOf,
  normalizePoint,
  parseAnnotationOps,
  parseStroke,
  spaceOf,
} from '../../shared/annotation.ts'
import {
  BOARD_EXTENT,
  BOARD_LIMITS,
  MAX_BOARD_STROKE_POINTS,
  SHARE_LIMITS,
} from '../../shared/annotation-limits.ts'
import {
  BOARD_HOME,
  BOARD_MAX_ZOOM,
  BOARD_MIN_ZOOM,
  BOARD_UNIT_PX,
  boardGrid,
  boardPanBy,
  boardRect,
  boardZoomAt,
  clampBoardView,
} from '../../shared/boardGeometry.ts'
import { shareSlots, stageSources } from '../../shared/layout.ts'
import {
  ANNOTATION_POLICIES,
  ROLES,
  isAnnotationPolicy,
  mayClearLayer,
  mayCloseBoard,
  mayDraw,
  mayOpenBoard,
} from '../../shared/roles.ts'
import { contentToTile, tileToContent } from '../../shared/shareGeometry.ts'

const BOX = { width: 1200, height: 800 }

describe('a layer\'s space', () => {
  it('is 0–1 on a share and the world on the whiteboard', () => {
    expect(spaceOf('some-member')).toBe(PICTURE_SPACE)
    expect(spaceOf(WHITEBOARD_LAYER)).toBe(BOARD_SPACE)
    expect(limitsOf('some-member')).toBe(SHARE_LIMITS)
    expect(limitsOf(WHITEBOARD_LAYER)).toBe(BOARD_LIMITS)
  })

  it('keeps a point in its range, at the stored precision', () => {
    expect(normalizePoint(1.5, -1.5)).toEqual([1, 0])
    expect(normalizePoint(1.23456, -1.5, BOARD_SPACE)).toEqual([1.2346, -1.5])
    expect(normalizePoint(BOARD_EXTENT + 5, -BOARD_EXTENT - 5, BOARD_SPACE)).toEqual([
      BOARD_EXTENT,
      -BOARD_EXTENT,
    ])
    expect(normalizePoint(Number.NaN, 0, BOARD_SPACE)).toBeNull()
  })

  it('says what is inside it', () => {
    expect(insideSpace({ x: 1.5, y: 0 }, PICTURE_SPACE)).toBe(false)
    expect(insideSpace({ x: 1.5, y: -3 }, BOARD_SPACE)).toBe(true)
    expect(insideSpace({ x: BOARD_EXTENT + 1, y: 0 }, BOARD_SPACE)).toBe(false)
  })

  it('a stroke starts and grows in world coordinates', () => {
    const begun = beginStroke({
      by: 'me',
      tool: 'pen',
      at: { x: -2.5, y: 3 },
      space: BOARD_SPACE,
    })!
    expect(begun.points).toEqual([[-2.5, 3]])
    const next = extendStroke(begun, { x: -2, y: 3.5 }, 1, BOARD_SPACE)
    expect(next.points).toEqual([
      [-2.5, 3],
      [-2, 3.5],
    ])
    // Without the space, the same point would be squeezed onto a share
    expect(beginStroke({ by: 'me', tool: 'pen', at: { x: -2.5, y: 3 } })!.points).toEqual([[0, 1]])
  })

  it('a long path thins at the board\'s own cap', () => {
    let stroke = beginStroke({ by: 'me', tool: 'pen', at: { x: 0, y: 0 }, space: BOARD_SPACE })!
    for (let i = 1; i <= MAX_BOARD_STROKE_POINTS + 10; i++) {
      stroke = extendStroke(stroke, { x: i / 50, y: Math.sin(i) * 3 }, 1, BOARD_SPACE)
    }
    expect(stroke.points.length).toBeLessThanOrEqual(MAX_BOARD_STROKE_POINTS)
  })

  it('parses by the layer\'s rules', () => {
    const raw = { id: 'a', by: '', tool: 'pen', color: 'rose', width: 'thin', points: [[-5, 5]] }
    expect(parseStroke(raw)).toBeNull()
    expect(parseStroke(raw, BOARD_SPACE)?.points).toEqual([[-5, 5]])
    expect(parseAnnotationOps([{ op: 'laser', at: [9, 9], color: 'blue' }])).toBeNull()
    expect(parseAnnotationOps([{ op: 'laser', at: [9, 9], color: 'blue' }], BOARD_SPACE)).toEqual([
      { op: 'laser', at: [9, 9], color: 'blue' },
    ])
  })

  it('an update applies by the layer\'s point cap', () => {
    const stroke = { ...parseStroke({ id: 'a', by: '', tool: 'pen', color: 'rose', width: 'thin', points: [[0, 0]] })! }
    const many = Array.from({ length: 700 }, (_, i): [number, number] => [i / 1000, 0])
    expect(applyStrokeUpdate(stroke, 1, many)).not.toBeNull()
    expect(applyStrokeUpdate(stroke, 1, many, BOARD_SPACE)).toBeNull()
  })
})

describe('the board on screen', () => {
  it('home: the world\'s centre in the tile\'s centre, one unit is BOARD_UNIT_PX', () => {
    const rect = boardRect(BOX, BOARD_HOME)
    expect(contentToTile(rect, { x: 0, y: 0 })).toEqual({ x: 600, y: 400 })
    expect(contentToTile(rect, { x: 0.1, y: -0.1 })).toEqual({
      x: 600 + 0.1 * BOARD_UNIT_PX,
      y: 400 - 0.1 * BOARD_UNIT_PX,
    })
  })

  it('maps there and back at any view', () => {
    const rect = boardRect(BOX, { zoom: 2.5, cx: 3, cy: -7 })
    const back = tileToContent(rect, contentToTile(rect, { x: 4.25, y: -6.5 }))
    expect(back.x).toBeCloseTo(4.25)
    expect(back.y).toBeCloseTo(-6.5)
  })

  it('zooming keeps what is under the pointer where it is', () => {
    const anchor = { x: 200, y: 700 }
    const before = boardRect(BOX, BOARD_HOME)
    const held = tileToContent(before, anchor)
    const zoomed = boardZoomAt(BOX, BOARD_HOME, 3, anchor)
    expect(zoomed.zoom).toBe(3)
    const after = contentToTile(boardRect(BOX, zoomed), held)
    expect(after.x).toBeCloseTo(anchor.x)
    expect(after.y).toBeCloseTo(anchor.y)
  })

  it('zooms from 25% to 400%, no further', () => {
    expect(BOARD_MIN_ZOOM).toBe(0.25)
    expect(BOARD_MAX_ZOOM).toBe(4)
    expect(boardZoomAt(BOX, BOARD_HOME, 0.01).zoom).toBe(0.25)
    expect(boardZoomAt(BOX, BOARD_HOME, 99).zoom).toBe(4)
  })

  it('pans by screen pixels at any zoom, in the direction of the drag', () => {
    const view = boardPanBy({ zoom: 2, cx: 0, cy: 0 }, 100, -50)
    const rect = boardRect(BOX, view)
    expect(contentToTile(rect, { x: 0, y: 0 })).toEqual({ x: 700, y: 350 })
  })

  it('stops at the world\'s edge, and never trusts a broken number', () => {
    expect(boardPanBy(BOARD_HOME, -1e12, 1e12)).toEqual({
      zoom: 1,
      cx: BOARD_EXTENT,
      cy: -BOARD_EXTENT,
    })
    expect(clampBoardView({ zoom: Number.NaN, cx: Number.NaN, cy: Infinity })).toEqual({
      zoom: 1,
      cx: 0,
      cy: 0,
    })
  })

  it('the grid moves with the board and thins out when far away', () => {
    const at100 = boardGrid(boardRect(BOX, BOARD_HOME))
    expect(at100.size).toBe(50)
    expect(at100.x).toBe(600 % 50)
    const far = boardGrid(boardRect(BOX, { zoom: 0.25, cx: 0, cy: 0 }))
    expect(far.size).toBeGreaterThanOrEqual(20)
    // Lines stay on the same world positions after a pan
    const panned = boardGrid(boardRect(BOX, boardPanBy(BOARD_HOME, 7, 11)))
    expect(panned.x).toBe((600 + 7) % 50)
    expect(panned.y).toBe((400 + 11) % 50)
    // A negative position wraps into the first cell
    expect(boardGrid(boardRect(BOX, { zoom: 1, cx: 5, cy: 5 })).x).toBeGreaterThanOrEqual(0)
  })
})

describe('what can take the main area', () => {
  const shares = [
    { memberId: 'a', since: 10 },
    { memberId: 'b', since: 30 },
  ]

  it('is the shares when there is no board', () => {
    expect(stageSources(shares, null)).toEqual(['a', 'b'])
  })

  it('puts the board among them by when it opened', () => {
    expect(stageSources(shares, { layer: WHITEBOARD_LAYER, since: 20 })).toEqual([
      'a',
      WHITEBOARD_LAYER,
      'b',
    ])
    expect(stageSources(shares, { layer: WHITEBOARD_LAYER, since: 40 }).at(-1)).toBe(
      WHITEBOARD_LAYER,
    )
    expect(stageSources([], { layer: WHITEBOARD_LAYER, since: 40 })).toEqual([WHITEBOARD_LAYER])
  })

  it('the latest takes the main area, unless the viewer chose something', () => {
    const sources = stageSources(shares, { layer: WHITEBOARD_LAYER, since: 40 })
    expect(shareSlots(sources, null, null)).toEqual({
      main: WHITEBOARD_LAYER,
      strip: ['a', 'b'],
    })
    expect(shareSlots(sources, null, 'a').main).toBe('a')
    expect(shareSlots(sources, null, 'a').strip).toEqual(['b', WHITEBOARD_LAYER])
  })

  it('a board closed falls back to the shares, even when it was chosen', () => {
    expect(shareSlots(stageSources(shares, null), null, WHITEBOARD_LAYER).main).toBe('b')
  })

  it('our own share comes to the main area only when asked for', () => {
    expect(shareSlots(['a', 'me'], 'me', null).main).toBe('a')
    expect(shareSlots(['a', 'me'], null, 'me')).toEqual({ main: 'me', strip: ['a'] })
  })
})

describe('who may do what with marks', () => {
  /** Every role × policy × owner, spelled out: H host, C co-host, P participant, W waiting */
  it('draw', () => {
    const allowed = (policy: (typeof ANNOTATION_POLICIES)[number], owner: boolean) =>
      ROLES.filter((role) => mayDraw(policy, role, owner)).join()
    expect(allowed('everyone', false)).toBe('host,cohost,participant')
    expect(allowed('everyone', true)).toBe('host,cohost,participant')
    expect(allowed('sharer', false)).toBe('host,cohost')
    expect(allowed('sharer', true)).toBe('host,cohost,participant')
    expect(allowed('off', false)).toBe('')
    expect(allowed('off', true)).toBe('')
  })

  it('clear: a host, a co-host, the owner; never someone waiting', () => {
    expect(ROLES.filter((role) => mayClearLayer(role, false)).join()).toBe('host,cohost')
    expect(ROLES.filter((role) => mayClearLayer(role, true)).join()).toBe('host,cohost,participant')
    expect(mayCloseBoard('participant', false)).toBe(false)
    expect(mayCloseBoard('participant', true)).toBe(true)
  })

  it('open the board', () => {
    expect(ROLES.filter((role) => mayOpenBoard('everyone', role)).join()).toBe(
      'host,cohost,participant',
    )
    expect(ROLES.filter((role) => mayOpenBoard('sharer', role)).join()).toBe('host,cohost')
    expect(ROLES.filter((role) => mayOpenBoard('off', role)).join()).toBe('host,cohost')
  })

  it('knows the three states', () => {
    expect(ANNOTATION_POLICIES).toEqual(['everyone', 'sharer', 'off'])
    expect(isAnnotationPolicy('sharer')).toBe(true)
    expect(isAnnotationPolicy('all')).toBe(false)
  })
})
