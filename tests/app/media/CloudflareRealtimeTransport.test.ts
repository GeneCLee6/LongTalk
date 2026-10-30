import { describe, expect, it, vi } from 'vitest'
import { CloudflareRealtimeTransport } from '../../../src/media/CloudflareRealtimeTransport.ts'

// A scripted stand-in for RTCPeerConnection: enough to check that the transport makes the
// Realtime calls in the documented order with the documented bodies. The real browser path is
// what the two-device spike checks (DEPLOY.md §5).
class MockPc {
  transceivers: { mid: string | null; stop: () => void; receiver: { track: unknown } }[] = []
  localDescription: { type: string; sdp: string } | null = null
  remoteDescriptions: { type: string; sdp: string }[] = []
  iceGatheringState = 'complete'
  connectionState = 'new'
  closed = false
  #nextMid = 0

  addEventListener() {}
  removeEventListener() {}
  addTransceiver(track: unknown) {
    const t = {
      mid: null as string | null,
      stop: vi.fn(),
      receiver: { track: { from: 'local', track } },
    }
    this.transceivers.push(t)
    return t
  }
  async createOffer() {
    return { type: 'offer', sdp: `offer-${this.transceivers.length}` }
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer' }
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    for (const t of this.transceivers) t.mid ??= String(this.#nextMid++)
    this.localDescription = d
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescriptions.push(d)
    // The SFU's offer for a pulled track adds a receiving transceiver with the mid it chose
    const pulled = /pull-mid-(\d+)/.exec(d.sdp)
    if (pulled)
      this.transceivers.push({
        mid: pulled[1],
        stop: vi.fn(),
        receiver: { track: { remote: pulled[1] } },
      })
  }
  getTransceivers() {
    return this.transceivers
  }
  async getStats() {
    return new Map<string, Record<string, unknown>>([
      [
        'p',
        {
          id: 'p',
          type: 'candidate-pair',
          nominated: true,
          state: 'succeeded',
          currentRoundTripTime: 0.042,
          bytesSent: 10,
          bytesReceived: 20,
          localCandidateId: 'l',
        },
      ],
      ['l', { id: 'l', type: 'local-candidate', candidateType: 'relay' }],
    ])
  }
  close() {
    this.closed = true
  }
}

type Call = { method: string; url: string; body: unknown }

function setup(responses: Record<string, unknown>) {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: String(url), body })
    const key = `${method} ${String(url)}`
    if (!(key in responses)) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json(responses[key])
  })
  const pc = new MockPc()
  const transport = new CloudflareRealtimeTransport({
    fetch: fetchMock,
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
  })
  return { transport, pc, calls }
}

const track = { kind: 'audio' } as MediaStreamTrack

describe('CloudflareRealtimeTransport', () => {
  it('creates a session through the Worker proxy on connect', async () => {
    const { transport, calls } = setup({ 'POST /api/sfu/sessions': { sessionId: 'me' } })
    await transport.connect()
    expect(transport.sessionId).toBe('me')
    expect(transport.state).toBe('connected')
    expect(calls).toEqual([{ method: 'POST', url: '/api/sfu/sessions', body: undefined }])
  })

  it('publishes with our offer and applies the SFU answer', async () => {
    const { transport, pc, calls } = setup({
      'POST /api/sfu/sessions': { sessionId: 'me' },
      'POST /api/sfu/sessions/me/tracks': {
        sessionDescription: { type: 'answer', sdp: 'sfu-answer' },
        tracks: [{ mid: '0', trackName: 'x' }],
      },
    })
    await transport.connect()
    const published = await transport.publish(track, { kind: 'mic' })
    expect(published).toMatchObject({ sessionId: 'me', kind: 'mic' })
    expect(published.trackName).toMatch(/^mic-/)
    expect(calls[1].body).toEqual({
      sessionDescription: { type: 'offer', sdp: 'offer-1' },
      tracks: [{ location: 'local', mid: '0', trackName: published.trackName }],
    })
    expect(pc.remoteDescriptions).toEqual([{ type: 'answer', sdp: 'sfu-answer' }])
  })

  it('pulls a remote track and answers the SFU offer with renegotiate', async () => {
    const { transport, calls } = setup({
      'POST /api/sfu/sessions': { sessionId: 'me' },
      'POST /api/sfu/sessions/me/tracks': {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'pull-mid-3' },
        tracks: [{ mid: '3', sessionId: 'them', trackName: 'cam-1' }],
      },
      'PUT /api/sfu/sessions/me/renegotiate': {},
    })
    await transport.connect()
    const onTrack = vi.fn()
    transport.on('track', onTrack)
    const remote = await transport.subscribe({ sessionId: 'them', trackName: 'cam-1' })
    expect(remote.track).toEqual({ remote: '3' })
    expect(onTrack).toHaveBeenCalledWith(remote)
    expect(calls[1].body).toEqual({
      tracks: [{ location: 'remote', sessionId: 'them', trackName: 'cam-1' }],
    })
    expect(calls[2]).toEqual({
      method: 'PUT',
      url: '/api/sfu/sessions/me/renegotiate',
      body: { sessionDescription: { type: 'answer', sdp: 'answer' } },
    })
  })

  it('closes a subscription with a negotiated tracks/close', async () => {
    const { transport, pc, calls } = setup({
      'POST /api/sfu/sessions': { sessionId: 'me' },
      'POST /api/sfu/sessions/me/tracks': {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'pull-mid-3' },
        tracks: [{ mid: '3' }],
      },
      'PUT /api/sfu/sessions/me/renegotiate': {},
      'PUT /api/sfu/sessions/me/tracks/close': {
        sessionDescription: { type: 'answer', sdp: 'closed' },
      },
    })
    await transport.connect()
    const ref = { sessionId: 'them', trackName: 'cam-1' }
    await transport.subscribe(ref)
    const onEnded = vi.fn()
    transport.on('trackEnded', onEnded)
    await transport.unsubscribe(ref)
    expect(pc.transceivers[0].stop).toHaveBeenCalled()
    expect(calls.at(-1)?.body).toMatchObject({ tracks: [{ mid: '3' }], force: false })
    expect(onEnded).toHaveBeenCalledWith(ref)
  })

  it('asks for a simulcast layer by rid with tracks/update', async () => {
    const { transport, calls } = setup({
      'POST /api/sfu/sessions': { sessionId: 'me' },
      'POST /api/sfu/sessions/me/tracks': {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'pull-mid-3' },
        tracks: [{ mid: '3' }],
      },
      'PUT /api/sfu/sessions/me/renegotiate': {},
      'PUT /api/sfu/sessions/me/tracks/update': { tracks: [{ mid: '3' }] },
    })
    await transport.connect()
    const ref = { sessionId: 'them', trackName: 'cam-1' }
    await transport.subscribe(ref)
    await transport.setPreferredLayer(ref, 'low')
    expect(calls.at(-1)?.body).toMatchObject({
      tracks: [{ mid: '3', simulcast: { preferredRid: 'q' } }],
    })
  })

  it('reports a per-track SFU error and an unconfigured Worker as typed errors', async () => {
    const { transport } = setup({
      'POST /api/sfu/sessions': { sessionId: 'me' },
      'POST /api/sfu/sessions/me/tracks': { tracks: [{ errorCode: 'track_not_found' }] },
    })
    await transport.connect()
    await expect(transport.subscribe({ sessionId: 'x', trackName: 'y' })).rejects.toMatchObject({
      code: 'not_found',
    })

    const unconfigured = new CloudflareRealtimeTransport({
      fetch: async () => Response.json({ error: 'sfu_not_configured' }, { status: 503 }),
      createPeerConnection: () => new MockPc() as unknown as RTCPeerConnection,
    })
    await expect(unconfigured.connect()).rejects.toMatchObject({ code: 'sfu_not_configured' })
    expect(unconfigured.state).toBe('failed')
  })

  it('summarises the selected candidate pair, including TURN use', async () => {
    const { transport } = setup({ 'POST /api/sfu/sessions': { sessionId: 'me' } })
    await transport.connect()
    expect(await transport.getStats()).toEqual({
      rttMs: 42,
      usingRelay: true,
      bytesSent: 10,
      bytesReceived: 20,
    })
  })

  it('closes the PeerConnection and refuses further calls', async () => {
    const { transport, pc } = setup({ 'POST /api/sfu/sessions': { sessionId: 'me' } })
    await transport.connect()
    await transport.close()
    expect(pc.closed).toBe(true)
    await expect(transport.publish(track, { kind: 'mic' })).rejects.toMatchObject({
      code: 'closed',
    })
  })
})
