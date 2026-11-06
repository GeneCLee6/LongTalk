import { describe, expect, it, vi } from 'vitest'
import type { ClientMessage, MemberTrack } from '../../shared/protocol.ts'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import type { VideoDemand } from '../../src/media/layers.ts'
import { RoomMedia } from '../../src/room/RoomMedia.ts'
import { VideoDemandStore } from '../../src/room/videoDemand.ts'

// H1 (e2-t11, e2-t12): RoomMedia publishes cameras and screens in simulcast layers and asks for
// each received one's layer from where the tiles draw it (VideoDemandStore), through
// MediaTransport.setPreferredLayer only.

const fakeTrack = (kind: 'audio' | 'video') =>
  ({ kind, applyConstraints: vi.fn(async () => {}) }) as unknown as MediaStreamTrack

const DEBOUNCE = 20
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const debounced = () => settle(DEBOUNCE * 3)

function listed(sent: ClientMessage[]): MemberTrack[] {
  const last = sent.filter((s) => s.t === 'tracks').at(-1)
  if (last?.t !== 'tracks') return []
  return last.tracks.map((t) => ({ sessionId: last.sessionId, ...t }))
}

const drawn = (width: number, height: number, visible = true): VideoDemand => ({
  width,
  height,
  visible,
  aspect: 16 / 9,
})

async function room(retryDelayMs?: number) {
  const sfu = new FakeSfu()
  const aliceTransport = sfu.createTransport()
  const aliceSent: ClientMessage[] = []
  const alice = new RoomMedia({ transport: aliceTransport, send: (m) => aliceSent.push(m) })
  const cam = fakeTrack('video')
  await alice.start({ mic: fakeTrack('audio'), cam })
  const demand = new VideoDemandStore()
  const bobTransport = sfu.createTransport()
  const bob = new RoomMedia({
    transport: bobTransport,
    send: () => {},
    demand,
    layerDebounceMs: DEBOUNCE,
    retryDelayMs,
  })
  await bob.start({ mic: null, cam: null })
  bob.setDesired(listed(aliceSent))
  await settle()
  const camKey = Object.keys(bob.getState().received).find((k) => k.includes('/cam-'))!
  return { sfu, alice, aliceTransport, aliceSent, cam, bob, bobTransport, demand, camKey }
}

describe('RoomMedia: simulcast layers (e2-t11, e2-t12)', () => {
  it('publishes the camera and the screen in layers, the microphone as it is', async () => {
    const { alice, aliceTransport } = await room()
    await alice.setScreen(fakeTrack('video'))
    const options = Object.fromEntries(
      [...aliceTransport.publishOptions.values()].map((o) => [o.kind, o.simulcast]),
    )
    expect(options).toEqual({ mic: false, cam: true, screen: true })
  })

  it('starts a received camera at medium, then follows its tile', async () => {
    const { bob, bobTransport, demand, camKey, cam } = await room()
    expect(bobTransport.preferredLayers.get(camKey)).toBe('medium')
    expect(bob.getState().layers).toEqual({ [camKey]: 'medium' })
    const view = {}
    // The speaker's big tile
    demand.report(cam, view, drawn(1280, 720))
    await debounced()
    expect(bobTransport.preferredLayers.get(camKey)).toBe('high')
    // Into the strip
    demand.report(cam, view, drawn(220, 124))
    await debounced()
    expect(bobTransport.preferredLayers.get(camKey)).toBe('low')
    // Scrolled out of view, then back as a grid tile
    demand.report(cam, view, drawn(220, 124, false))
    await debounced()
    demand.report(cam, view, drawn(560, 315))
    await debounced()
    expect(bobTransport.layerRequests.map((r) => r.layer)).toEqual(['high', 'low', 'medium'])
    expect(bob.getState().layers[camKey]).toBe('medium')
  })

  it('settles a burst of layout changes into one request', async () => {
    const { bobTransport, demand, cam } = await room()
    const view = {}
    for (const height of [200, 300, 500, 650, 720]) {
      demand.report(cam, view, drawn(Math.round((height * 16) / 9), height))
      await settle(2)
    }
    await debounced()
    expect(bobTransport.layerRequests.map((r) => r.layer)).toEqual(['high'])
  })

  it('drops to the lowest layer when no tile draws the video or the tab is hidden', async () => {
    const { bobTransport, demand, camKey, cam } = await room()
    const view = {}
    demand.report(cam, view, drawn(1280, 720))
    await debounced()
    demand.setPageHidden(true)
    await debounced()
    expect(bobTransport.preferredLayers.get(camKey)).toBe('low')
    demand.setPageHidden(false)
    await debounced()
    expect(bobTransport.preferredLayers.get(camKey)).toBe('high')
    // The camera turned off: its tile shows the initial, and stops reporting
    demand.report(cam, view, null)
    await debounced()
    expect(bobTransport.preferredLayers.get(camKey)).toBe('low')
  })

  it('takes the biggest visible place a video is drawn in', async () => {
    const { bobTransport, demand, camKey, cam } = await room()
    const strip = {}
    const big = {}
    demand.report(cam, strip, drawn(220, 124))
    demand.report(cam, big, drawn(1280, 720))
    await debounced()
    expect(bobTransport.preferredLayers.get(camKey)).toBe('high')
    demand.report(cam, big, null)
    await debounced()
    expect(bobTransport.preferredLayers.get(camKey)).toBe('low')
  })

  it('starts a received screen at high and keeps a share box on it', async () => {
    const { alice, aliceSent, bob, bobTransport, demand } = await room()
    const screen = fakeTrack('video')
    await alice.setScreen(screen)
    bob.setDesired(listed(aliceSent))
    await settle()
    const key = Object.keys(bob.getState().received).find((k) => k.includes('/screen-'))!
    expect(bobTransport.preferredLayers.get(key)).toBe('high')
    const box = {}
    demand.report(screen, box, drawn(1500, 840))
    await debounced()
    expect(bobTransport.layerRequests.filter((r) => r.key === key)).toEqual([])
    // A phone's small share box: the screen's second layer (it has no third)
    demand.report(screen, box, drawn(390, 220))
    await debounced()
    expect(bobTransport.preferredLayers.get(key)).toBe('medium')
    demand.report(screen, box, drawn(390, 220, false))
    await debounced()
    expect(bobTransport.preferredLayers.get(key)).toBe('medium')
  })

  it('forgets the layers of a track that left, and asks nothing without a demand store', async () => {
    const { aliceSent, bob, camKey } = await room()
    bob.setDesired(listed(aliceSent).filter((t) => t.kind !== 'cam'))
    await settle()
    expect(bob.getState().layers).toEqual({})

    const sfu = new FakeSfu()
    const pubSent: ClientMessage[] = []
    const pub = new RoomMedia({ transport: sfu.createTransport(), send: (m) => pubSent.push(m) })
    await pub.start({ mic: null, cam: fakeTrack('video') })
    const plainTransport = sfu.createTransport()
    const plain = new RoomMedia({ transport: plainTransport, send: () => {}, layerDebounceMs: 1 })
    await plain.start({ mic: null, cam: null })
    plain.setDesired(listed(pubSent))
    await settle(10)
    expect(plainTransport.layerRequests).toEqual([])
    expect(camKey).toMatch(/\/cam-/)
  })

  it('sends a layout change made while the connection was down once it is back', async () => {
    const { bobTransport, demand, camKey, cam } = await room()
    bobTransport.simulateState('reconnecting')
    demand.report(cam, {}, drawn(1280, 720))
    await debounced()
    expect(bobTransport.layerRequests).toEqual([])
    bobTransport.simulateState('connected')
    await debounced()
    expect(bobTransport.preferredLayers.get(camKey)).toBe('high')
  })

  it('asks again when a layer request fails', async () => {
    const { bob, bobTransport, demand, camKey, cam } = await room(DEBOUNCE)
    const real = bobTransport.setPreferredLayer.bind(bobTransport)
    let failures = 1
    bobTransport.setPreferredLayer = async (ref, layer) => {
      if (failures-- > 0) throw new Error('sfu_error')
      return real(ref, layer)
    }
    demand.report(cam, {}, drawn(1280, 720))
    await debounced()
    // The first try failed and was forgotten; the retry after retryDelayMs got through
    await vi.waitFor(() => expect(bobTransport.preferredLayers.get(camKey)).toBe('high'))
    expect(bob.getState().layers[camKey]).toBe('high')
  })
})

describe('VideoDemandStore', () => {
  it('reports once per change, and nothing for the same demand again', () => {
    const store = new VideoDemandStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const track = fakeTrack('video')
    const view = {}
    store.report(track, view, drawn(100, 50))
    store.report(track, view, drawn(100, 50))
    expect(listener).toHaveBeenCalledTimes(1)
    store.report(track, view, null)
    store.report(track, view, null)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.get(track)).toBeNull()
  })

  it('prefers a visible view to a bigger hidden one', () => {
    const store = new VideoDemandStore()
    const track = fakeTrack('video')
    store.report(track, {}, drawn(1000, 600, false))
    store.report(track, {}, drawn(200, 120))
    expect(store.get(track)).toMatchObject({ width: 200, visible: true })
  })
})
