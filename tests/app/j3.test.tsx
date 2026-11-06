import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WHITEBOARD_LAYER } from '../../shared/annotation.ts'
import type { Member } from '../../shared/protocol.ts'
import AnnotationLayer from '../../src/annotate/AnnotationLayer.tsx'
import ClearMarks from '../../src/annotate/ClearMarks.tsx'
import { AnnotationDrawer } from '../../src/annotate/sync.ts'
import Whiteboard from '../../src/annotate/Whiteboard.tsx'
import { BoardStripTile } from '../../src/components/BoardStripTile.tsx'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import { SharePicker } from '../../src/components/SharePicker.tsx'
import { ShareTile } from '../../src/components/ShareTile.tsx'
import { SharingBar } from '../../src/components/SharingBar.tsx'
import { ShareGeometryContext } from '../../src/components/useShareGeometry.ts'
import { AnnotationStore } from '../../src/room/annotationStore.ts'
import { setLocale, strings } from '../../src/strings.ts'

// J3 (e7-t05, e7-t06): the three states in the participants panel, the clear dialog, the sharer's
// own view, the whiteboard's tile. What the room decides is tests/worker/room-j3.test.ts; pixels and
// real browsers are e2e/local/whiteboard.spec.ts.

function storeWith() {
  const sent: unknown[] = []
  const store = new AnnotationStore({ send: (message) => sent.push(message), isOpen: () => true })
  return { store, sent }
}

const stroke = (id: string, by: string) => ({
  id,
  by,
  tool: 'pen' as const,
  color: 'rose' as const,
  width: 'medium' as const,
  points: [[0.1, 0.1]] as [number, number][],
})

const member = (id: string, name: string, role: Member['role']): Member =>
  ({
    id,
    name,
    role,
    tracks: [],
    joinedAt: 1,
    reconnecting: false,
    hand: null,
    signal: null,
    mayRecord: false,
  }) as Member

const originalContext = HTMLCanvasElement.prototype.getContext
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  vi.stubGlobal('requestAnimationFrame', undefined)
})
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalContext
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('who may annotate, in the participants panel', () => {
  const panel = (role: Member['role'], onAnnotationPolicy = vi.fn()) => {
    render(
      <ParticipantsPanel
        members={[member('me', 'Me', role)]}
        you="me"
        sharerIds={[]}
        onAction={() => {}}
        onMuteAll={() => {}}
        onEndMeeting={() => {}}
        annotationPolicy="sharer"
        onAnnotationPolicy={onAnnotationPolicy}
      />,
    )
    return onAnnotationPolicy
  }

  it('a host and a co-host choose among the three states, and see what the state means', () => {
    for (const role of ['host', 'cohost'] as const) {
      const change = panel(role)
      const select = screen.getByRole('combobox', { name: strings.annotation.policy.label })
      expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
        strings.annotation.policy.options.everyone,
        strings.annotation.policy.options.sharer,
        strings.annotation.policy.options.off,
      ])
      expect(select).toHaveValue('sharer')
      expect(screen.getByText(strings.annotation.policy.hint.sharer)).toBeInTheDocument()
      fireEvent.change(select, { target: { value: 'off' } })
      expect(change).toHaveBeenCalledWith('off')
      document.body.innerHTML = ''
    }
  })

  it('a participant has no such control', () => {
    panel('participant')
    expect(screen.queryByRole('combobox', { name: strings.annotation.policy.label })).toBeNull()
  })
})

describe('clearing other people\'s marks', () => {
  function marked() {
    const { store, sent } = storeWith()
    store.receive({
      t: 'annotations',
      share: 'bob',
      strokes: [stroke('a', 'alice'), stroke('b', 'alice'), stroke('c', 'carol'), stroke('d', 'gone')],
      reset: true,
      done: true,
    })
    const nameOf = (id: string) => ({ alice: 'Alice', carol: 'Carol' })[id] ?? null
    render(<ClearMarks store={store} layer="bob" nameOf={nameOf} />)
    fireEvent.click(screen.getByRole('button', { name: strings.annotation.clearOthers }))
    return { store, sent }
  }

  it('lists everything and each person, with how much', () => {
    marked()
    const dialog = screen.getByRole('dialog', { name: strings.annotation.clearOthers })
    const names = within(dialog).getAllByRole('button').map((b) => b.textContent)
    expect(names).toEqual([
      strings.annotation.clearAll(4),
      strings.annotation.clearOne('Alice', 2),
      strings.annotation.clearOne('Carol', 1),
      strings.annotation.clearOne(strings.annotation.departed, 1),
      strings.common.cancel,
    ])
  })

  it('nothing is sent until the second question is answered', () => {
    const { sent } = marked()
    fireEvent.click(screen.getByRole('button', { name: strings.annotation.clearAll(4) }))
    expect(sent).toEqual([])
    const confirm = screen.getByRole('alertdialog', { name: strings.annotation.clearAllTitle })
    fireEvent.click(within(confirm).getByRole('button', { name: strings.annotation.clearConfirm }))
    expect(sent).toEqual([{ t: 'clearAnnotations', share: 'bob', by: null }])
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('one person\'s, naming them in the question', () => {
    const { sent } = marked()
    fireEvent.click(screen.getByRole('button', { name: strings.annotation.clearOne('Carol', 1) }))
    expect(screen.getByText(strings.annotation.clearOneBody('Carol'))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: strings.annotation.clearConfirm }))
    expect(sent).toEqual([{ t: 'clearAnnotations', share: 'bob', by: 'carol' }])
  })

  it('cancelling at either step sends nothing, and Esc works', () => {
    const { sent } = marked()
    fireEvent.click(screen.getByRole('button', { name: strings.common.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: strings.annotation.clearOthers }))
    fireEvent.click(screen.getByRole('button', { name: strings.annotation.clearAll(4) }))
    fireEvent.click(screen.getByRole('button', { name: strings.common.cancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: strings.annotation.clearOthers }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sent).toEqual([])
  })

  it('in English too', () => {
    setLocale('en', false)
    marked()
    expect(screen.getByRole('button', { name: "Clear Alice's (2)" })).toBeInTheDocument()
  })
})

describe('the store', () => {
  it('counts who has how many, and forgets what the room cleared', () => {
    const { store } = storeWith()
    store.receive({
      t: 'annotation',
      share: 'bob',
      by: 'alice',
      ops: [
        { op: 'add', stroke: stroke('a', 'alice') },
        { op: 'add', stroke: stroke('c', 'carol') },
      ],
    })
    expect([...store.authors('bob')]).toEqual([
      ['alice', 1],
      ['carol', 1],
    ])
    store.receive({ t: 'annotation', share: 'bob', by: 'alice', ops: [{ op: 'clear', by: 'carol' }] })
    expect([...store.authors('bob')]).toEqual([['alice', 1]])
    store.receive({ t: 'annotation', share: 'bob', by: 'alice', ops: [{ op: 'clear' }] })
    expect(store.marked('bob')).toBe(false)
  })

  it('takes a whiteboard update in world coordinates', () => {
    const { store } = storeWith()
    store.receive({
      t: 'annotation',
      share: WHITEBOARD_LAYER,
      by: 'alice',
      ops: [
        { op: 'add', stroke: { ...stroke('a', 'alice'), points: [[-3, 4]] }, live: true },
        { op: 'update', id: 'a', at: 1, points: [[-3.5, 4.5]] },
      ],
    })
    expect(store.strokes(WHITEBOARD_LAYER)[0].points).toEqual([
      [-3, 4],
      [-3.5, 4.5],
    ])
  })
})

describe('a drawer on the whiteboard', () => {
  it('sends world coordinates, not squeezed into 0–1', () => {
    const { store, sent } = storeWith()
    const drawer = new AnnotationDrawer(store, WHITEBOARD_LAYER, 'me', {
      now: () => 0,
      setTimeout: () => 1,
      clearTimeout: () => {},
    })
    drawer.begin({ tool: 'pen', color: 'rose', width: 'medium', at: { x: -2.5, y: 3 } })
    expect(sent[0]).toMatchObject({
      t: 'annotate',
      share: WHITEBOARD_LAYER,
      ops: [{ op: 'add', stroke: { points: [[-2.5, 3]] }, live: true }],
    })
  })
})

describe('the tools when the room takes them away', () => {
  const geometry = {
    box: { width: 1000, height: 1000 },
    source: { width: 1000, height: 1000 },
    view: { zoom: 1, cx: 0.5, cy: 0.5 },
    rect: { x: 0, y: 0, width: 1000, height: 1000 },
    pixelRatio: 1,
    clientToContent: (x: number, y: number) => ({ x: x / 1000, y: y / 1000 }),
    contentToClient: () => null,
  }
  const layer = (store: AnnotationStore, me: string | null) => (
    <ShareGeometryContext.Provider value={geometry}>
      <AnnotationLayer store={store} share="bob" me={me} nameOf={() => null} editing />
    </ShareGeometryContext.Provider>
  )

  it('the toolbar goes, and a stroke in progress is taken back', async () => {
    const { store, sent } = storeWith()
    const view = render(layer(store, 'me'))
    expect(screen.getByRole('toolbar', { name: strings.annotation.toolbar })).toBeInTheDocument()
    const surface = screen.getByRole('img', { name: strings.screenShare.annotationCanvas })
    fireEvent.pointerDown(surface, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      pointerType: 'mouse',
      clientX: 100,
      clientY: 100,
    })
    expect(store.strokes('bob')).toHaveLength(1)
    view.rerender(layer(store, null))
    expect(screen.queryByRole('toolbar', { name: strings.annotation.toolbar })).toBeNull()
    // Nothing half-drawn stays here; the room hears `remove`, which it allows with the policy off
    expect(store.strokes('bob')).toHaveLength(0)
    await vi.waitFor(() => expect(JSON.stringify(sent)).toContain('"op":"remove"'))
  })
})

describe('the sharer\'s own view', () => {
  const fakeTrack = {
    kind: 'video',
    id: 'local',
    addEventListener: () => {},
    removeEventListener: () => {},
    getSettings: () => ({}),
  } as unknown as MediaStreamTrack

  const annotations = (store: AnnotationStore, manage = true) => ({
    store,
    share: 'me',
    me: 'me',
    manage,
    nameOf: () => null,
  })

  beforeEach(() => {
    vi.stubGlobal(
      'MediaStream',
      class {
        getTracks = () => [fakeTrack]
      },
    )
  })

  it('a window or tab: the picture shows, and the limit is stated', () => {
    const { store } = storeWith()
    render(
      <ShareTile name="Me" video={fakeTrack} annotations={annotations(store)} own={{ mirrorRisk: false }} />,
    )
    expect(screen.getByRole('figure', { name: strings.screenShare.ownRegion })).toBeInTheDocument()
    expect(screen.getByText(strings.screenShare.ownLabel)).toBeInTheDocument()
    expect(screen.getByText(strings.screenShare.ownLimit)).toBeInTheDocument()
    expect(screen.queryByText(strings.screenShare.ownHidden)).toBeNull()
    expect(screen.queryByRole('button', { name: strings.screenShare.ownShowPicture })).toBeNull()
    expect(document.querySelector('video')).not.toHaveStyle({ visibility: 'hidden' })
  })

  it('a whole screen: the picture starts hidden, with the way to show it', () => {
    const { store } = storeWith()
    render(
      <ShareTile name="Me" video={fakeTrack} annotations={annotations(store)} own={{ mirrorRisk: true }} />,
    )
    expect(screen.getByText(strings.screenShare.ownHidden)).toBeInTheDocument()
    expect(document.querySelector('video')).toHaveStyle({ visibility: 'hidden' })
    fireEvent.click(screen.getByRole('button', { name: strings.screenShare.ownShowPicture }))
    expect(document.querySelector('video')).not.toHaveStyle({ visibility: 'hidden' })
    expect(screen.queryByText(strings.screenShare.ownHidden)).toBeNull()
    expect(screen.getByRole('button', { name: strings.screenShare.ownHidePicture })).toBeInTheDocument()
  })

  it('the bar has the switch, which speaks up when someone drew', () => {
    const { store } = storeWith()
    const onToggle = vi.fn()
    render(<SharingBar onStop={() => {}} ownView={{ open: false, onToggle, store, layer: 'me' }} />)
    fireEvent.click(screen.getByRole('button', { name: strings.screenShare.ownOpen }))
    expect(onToggle).toHaveBeenCalled()
    act(() => {
      store.receive({
        t: 'annotation',
        share: 'me',
        by: 'bob',
        ops: [{ op: 'add', stroke: stroke('a', 'bob') }],
      })
    })
    expect(screen.getByRole('button', { name: strings.screenShare.ownOpenMarked })).toBeInTheDocument()
  })

  it('says how to close it while it is open', () => {
    const { store } = storeWith()
    render(<SharingBar onStop={() => {}} ownView={{ open: true, onToggle: () => {}, store, layer: 'me' }} />)
    expect(screen.getByRole('button', { name: strings.screenShare.ownClose })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('states the limit in English too', () => {
    setLocale('en', false)
    const { store } = storeWith()
    render(
      <ShareTile name="Me" video={fakeTrack} annotations={annotations(store)} own={{ mirrorRisk: false }} />,
    )
    expect(screen.getByText(/cannot draw on your real desktop/)).toBeInTheDocument()
  })
})

describe('a share tile with the tools refused', () => {
  it('a tile without permission has no 標註 button, and marks still show', () => {
    const { store } = storeWith()
    const fakeTrack = {
      kind: 'video',
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaStreamTrack
    vi.stubGlobal(
      'MediaStream',
      class {
        getTracks = () => [fakeTrack]
      },
    )
    render(
      <ShareTile
        name="Bob"
        video={fakeTrack}
        annotations={{ store, share: 'bob', me: null, nameOf: () => null }}
      />,
    )
    expect(screen.queryByRole('button', { name: strings.screenShare.annotate })).toBeNull()
  })
})

describe('the whiteboard', () => {
  const props = () => {
    const { store, sent } = storeWith()
    return { store, sent, nameOf: () => null, manage: false }
  }

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
    } as DOMRect)
  })

  const board = () => screen.getByRole('figure', { name: strings.whiteboard.region })

  it('someone who may draw has the pen out, and the toolbar without white', () => {
    const { store, nameOf, manage } = props()
    render(<Whiteboard store={store} me="me" manage={manage} nameOf={nameOf} />)
    expect(board()).toBeInTheDocument()
    const toolbar = screen.getByRole('toolbar', { name: strings.annotation.toolbar })
    expect(within(toolbar).queryByRole('button', { name: strings.annotation.colors.white })).toBeNull()
    expect(within(toolbar).getByRole('button', { name: strings.annotation.colors.ink })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: strings.whiteboard.pen })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('turning the pen off puts the toolbar away, so a drag moves the board', () => {
    const { store, nameOf, manage } = props()
    render(<Whiteboard store={store} me="me" manage={manage} nameOf={nameOf} />)
    fireEvent.click(screen.getByRole('button', { name: strings.whiteboard.pen }))
    expect(screen.queryByRole('toolbar', { name: strings.annotation.toolbar })).toBeNull()
    expect(board()).toHaveAttribute('data-zoom', '1')
    fireEvent.pointerDown(board(), { pointerId: 1, button: 0, pointerType: 'mouse', clientX: 0, clientY: 0 })
    fireEvent.pointerMove(board(), { pointerId: 1, buttons: 1, pointerType: 'mouse', clientX: 30, clientY: 0 })
    fireEvent.pointerUp(board(), { pointerId: 1, pointerType: 'mouse', clientX: 30, clientY: 0 })
    // The grid moves with it (its lines started on the tile's corner: 500 and 300 are whole cells)
    expect(board().style.backgroundPosition).toBe('30px 0px')
  })

  it('someone who may not draw watches, and is told so', () => {
    const { store, nameOf, manage } = props()
    render(<Whiteboard store={store} me={null} manage={manage} nameOf={nameOf} />)
    expect(screen.getByText(strings.whiteboard.viewOnly)).toBeInTheDocument()
    expect(screen.queryByRole('toolbar', { name: strings.annotation.toolbar })).toBeNull()
    expect(screen.queryByRole('button', { name: strings.whiteboard.pen })).toBeNull()
  })

  it('zooms from its controls, within 25%–400%, and goes home', () => {
    const { store, nameOf, manage } = props()
    render(<Whiteboard store={store} me={null} manage={manage} nameOf={nameOf} />)
    const out = screen.getByRole('button', { name: strings.screenShare.zoomOut })
    for (let i = 0; i < 8; i++) if (!(out as HTMLButtonElement).disabled) fireEvent.click(out)
    expect(board()).toHaveAttribute('data-zoom', '0.25')
    expect(out).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: strings.whiteboard.home(25) }))
    expect(board()).toHaveAttribute('data-zoom', '1')
  })

  it('the grid can be turned off', () => {
    const { store, nameOf, manage } = props()
    render(<Whiteboard store={store} me={null} manage={manage} nameOf={nameOf} />)
    expect(board()).toHaveAttribute('data-grid', 'on')
    fireEvent.click(screen.getByRole('button', { name: strings.whiteboard.grid }))
    expect(board()).toHaveAttribute('data-grid', 'off')
  })

  it('clearing and closing are there for who may', () => {
    const { store, nameOf } = props()
    store.receive({
      t: 'annotation',
      share: WHITEBOARD_LAYER,
      by: 'x',
      ops: [{ op: 'add', stroke: stroke('a', 'x') }],
    })
    const onClose = vi.fn()
    const view = render(<Whiteboard store={store} me="me" manage nameOf={nameOf} onClose={onClose} />)
    expect(screen.getByRole('button', { name: strings.annotation.clearOthers })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: strings.whiteboard.close }))
    expect(onClose).toHaveBeenCalled()
    view.rerender(<Whiteboard store={store} me="me" manage={false} nameOf={nameOf} />)
    expect(screen.queryByRole('button', { name: strings.annotation.clearOthers })).toBeNull()
    expect(screen.queryByRole('button', { name: strings.whiteboard.close })).toBeNull()
  })

  it('comes back to where this viewer left it', () => {
    const { store, nameOf, manage } = props()
    const first = render(<Whiteboard store={store} me={null} manage={manage} nameOf={nameOf} />)
    fireEvent.click(screen.getByRole('button', { name: strings.screenShare.zoomIn }))
    const zoom = board().getAttribute('data-zoom')
    first.unmount()
    render(<Whiteboard store={store} me={null} manage={manage} nameOf={nameOf} />)
    expect(board()).toHaveAttribute('data-zoom', zoom)
  })

  it('in the strip it is a button; in the picker it has its own name', () => {
    const onShowMain = vi.fn()
    render(<BoardStripTile onShowMain={onShowMain} />)
    fireEvent.click(screen.getByRole('button', { name: strings.whiteboard.show }))
    expect(onShowMain).toHaveBeenCalled()
    render(
      <SharePicker
        shares={[
          { id: 'a', name: 'Alice' },
          { id: WHITEBOARD_LAYER, name: 'x', label: strings.whiteboard.label },
        ]}
        main={WHITEBOARD_LAYER}
        onPick={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: strings.whiteboard.label })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: strings.screenShare.label('Alice') })).toBeInTheDocument()
  })
})
