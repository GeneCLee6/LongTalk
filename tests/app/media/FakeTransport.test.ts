import { describe, expect, it, vi } from 'vitest'
import { FakeSfu } from '../../../src/media/FakeTransport.ts'
import { MediaTransportError, type ConnectionState } from '../../../src/media/MediaTransport.ts'

function fakeTrack(kind: 'audio' | 'video'): MediaStreamTrack {
  return { id: `${kind}-${Math.random()}`, kind, stop: vi.fn() } as unknown as MediaStreamTrack
}

async function connectedPair() {
  const sfu = new FakeSfu()
  const alice = sfu.createTransport()
  const bob = sfu.createTransport()
  await alice.connect()
  await bob.connect()
  return { sfu, alice, bob }
}

describe('FakeTransport', () => {
  it('connects and reports the state changes', async () => {
    const transport = new FakeSfu().createTransport()
    const states: ConnectionState[] = []
    transport.on('state', (s) => states.push(s))
    expect(transport.state).toBe('new')
    await transport.connect()
    expect(states).toEqual(['connecting', 'connected'])
    expect(transport.sessionId).toMatch(/^fake-session-/)
  })

  it('refuses calls before connect', async () => {
    const transport = new FakeSfu().createTransport()
    await expect(transport.publish(fakeTrack('audio'), { kind: 'mic' })).rejects.toMatchObject({
      code: 'not_connected',
    })
  })

  it('lets one participant subscribe to what another published', async () => {
    const { alice, bob } = await connectedPair()
    const mic = fakeTrack('audio')
    const published = await alice.publish(mic, { kind: 'mic' })
    expect(published).toMatchObject({ sessionId: alice.sessionId, kind: 'mic' })

    const onTrack = vi.fn()
    bob.on('track', onTrack)
    const remote = await bob.subscribe(published)
    expect(remote.track).toBe(mic)
    expect(onTrack).toHaveBeenCalledWith(remote)
    // Subscribing twice returns the same subscription without another event
    expect(await bob.subscribe(published)).toBe(remote)
    expect(onTrack).toHaveBeenCalledOnce()
  })

  it('rejects a subscription to a track nobody published', async () => {
    const { bob } = await connectedPair()
    const error = await bob
      .subscribe({ sessionId: 'nope', trackName: 'cam-1' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MediaTransportError)
    expect(error).toMatchObject({ code: 'not_found' })
  })

  it('ends subscribers’ tracks when the publisher unpublishes', async () => {
    const { alice, bob } = await connectedPair()
    const published = await alice.publish(fakeTrack('video'), { kind: 'cam' })
    await bob.subscribe(published)
    const onEnded = vi.fn()
    bob.on('trackEnded', onEnded)
    await alice.unpublish(published.trackName)
    expect(onEnded).toHaveBeenCalledWith({
      sessionId: published.sessionId,
      trackName: published.trackName,
    })
    expect(bob.subscriptions.size).toBe(0)
  })

  it('ends subscribers’ tracks when the publisher closes', async () => {
    const { alice, bob } = await connectedPair()
    const published = await alice.publish(fakeTrack('video'), { kind: 'cam' })
    await bob.subscribe(published)
    const onEnded = vi.fn()
    bob.on('trackEnded', onEnded)
    await alice.close()
    expect(alice.state).toBe('closed')
    expect(onEnded).toHaveBeenCalledOnce()
    await expect(alice.connect()).rejects.toMatchObject({ code: 'closed' })
  })

  it('unsubscribes once and ignores repeats', async () => {
    const { alice, bob } = await connectedPair()
    const published = await alice.publish(fakeTrack('audio'), { kind: 'mic' })
    await bob.subscribe(published)
    const onEnded = vi.fn()
    bob.on('trackEnded', onEnded)
    await bob.unsubscribe(published)
    await bob.unsubscribe(published)
    expect(onEnded).toHaveBeenCalledOnce()
  })

  it('records the preferred layer only for subscribed tracks', async () => {
    const { alice, bob } = await connectedPair()
    const published = await alice.publish(fakeTrack('video'), { kind: 'cam', simulcast: true })
    await expect(bob.setPreferredLayer(published, 'low')).rejects.toMatchObject({
      code: 'not_found',
    })
    await bob.subscribe(published)
    await bob.setPreferredLayer(published, 'low')
    expect(bob.preferredLayers.get(`${published.sessionId}/${published.trackName}`)).toBe('low')
  })

  it('removes event handlers with the returned function', async () => {
    const transport = new FakeSfu().createTransport()
    const handler = vi.fn()
    const off = transport.on('state', handler)
    off()
    await transport.connect()
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets tests simulate a reconnect', async () => {
    const transport = new FakeSfu().createTransport()
    await transport.connect()
    const states: ConnectionState[] = []
    transport.on('state', (s) => states.push(s))
    transport.simulateState('reconnecting')
    transport.simulateState('connected')
    expect(states).toEqual(['reconnecting', 'connected'])
    expect(await transport.getStats()).toMatchObject({ usingRelay: false })
  })
})
