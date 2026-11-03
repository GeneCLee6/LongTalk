import { describe, expect, it, vi } from 'vitest'
import { CloudflareRealtimeTransport } from '../../../src/media/CloudflareRealtimeTransport.ts'

// A scripted stand-in for RTCPeerConnection: enough to check that the transport makes the
// Realtime calls in the documented order with the documented bodies. The real browser path is
// what the two-device spike checks (DEPLOY.md §5).
class MockPc {
  transceivers: {
    mid: string | null
    stop: () => void
    receiver: { track: unknown }
    sender?: {
      replaceTrack: ReturnType<typeof vi.fn>
      getParameters: () => Record<string, unknown>
      setParameters: ReturnType<typeof vi.fn>
    }
  }[] = []
  /** What each addTransceiver call asked for */
  inits: unknown[] = []
  localDescription: { type: string; sdp: string } | null = null
  remoteDescriptions: { type: string; sdp: string }[] = []
  iceGatheringState = 'complete'
  signalingState = 'stable'
  connectionState = 'new'
  closed = false
  #nextMid = 0

  addEventListener() {}
  removeEventListener() {}
  addTransceiver(track: unknown, init?: unknown) {
    this.inits.push(init)
    const t = {
      mid: null as string | null,
      stop: vi.fn(),
      receiver: { track: { from: 'local', track } },
      sender: {
        replaceTrack: vi.fn(async () => {}),
        getParameters: () => ({ transactionId: 't1', encodings: [{}] }),
        setParameters: vi.fn(async () => {}),
      },
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
  async setLocalDescription(d: { type: string; sdp?: string }) {
    if (d.type === 'rollback') {
      this.signalingState = 'stable'
      return
    }
    for (const t of this.transceivers) t.mid ??= String(this.#nextMid++)
    this.localDescription = d as { type: string; sdp: string }
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescriptions.push(d)
    this.signalingState = d.type === 'answer' ? 'stable' : 'have-remote-offer'
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

const TOKEN = 'T'.repeat(43)

function setup(responses: Record<string, unknown>, statuses: Record<string, number> = {}) {
  const calls: Call[] = []
  const auth: (string | null)[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: String(url), body })
    auth.push(new Headers(init?.headers).get('authorization'))
    const key = `${method} ${String(url)}`
    if (!(key in responses)) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json(responses[key], { status: statuses[key] ?? 200 })
  })
  const pc = new MockPc()
  const transport = new CloudflareRealtimeTransport({
    apiBase: '/api/sfu/abcdefghij',
    token: () => TOKEN,
    fetch: fetchMock,
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
  })
  return { transport, pc, calls, auth }
}

const track = { kind: 'audio' } as MediaStreamTrack

describe('CloudflareRealtimeTransport', () => {
  it('creates a session through the Worker proxy on connect', async () => {
    const { transport, calls } = setup({ 'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' } })
    await transport.connect()
    expect(transport.sessionId).toBe('me')
    expect(transport.state).toBe('connected')
    expect(calls).toEqual([
      { method: 'POST', url: '/api/sfu/abcdefghij/sessions', body: undefined },
    ])
  })

  it('publishes with our offer and applies the SFU answer', async () => {
    const { transport, pc, calls } = setup({
      'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
      'POST /api/sfu/abcdefghij/sessions/me/tracks': {
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

  it('sends the screen and camera with their encoding, start bitrate and degradation', async () => {
    const answer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
      'a=rtpmap:96 VP8/90000',
      'a=rtpmap:97 rtx/90000',
      'a=fmtp:97 apt=96',
    ].join('\r\n')
    const { transport, pc } = setup({
      'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
      'POST /api/sfu/abcdefghij/sessions/me/tracks': {
        sessionDescription: { type: 'answer', sdp: answer },
        tracks: [{ mid: '0', trackName: 'x' }],
      },
    })
    await transport.connect()
    await transport.publish({ kind: 'video' } as MediaStreamTrack, { kind: 'screen' })
    expect(pc.inits[0]).toEqual({
      direction: 'sendonly',
      sendEncodings: [
        { maxBitrate: 2_500_000, maxFramerate: 30, priority: 'high', networkPriority: 'high' },
      ],
    })
    expect(pc.remoteDescriptions[0].sdp).toContain('a=fmtp:96 x-google-start-bitrate=1000')
    expect(pc.transceivers[0].sender!.setParameters).toHaveBeenCalledWith({
      transactionId: 't1',
      encodings: [{}],
      degradationPreference: 'balanced',
    })

    await transport.publish({ kind: 'video' } as MediaStreamTrack, { kind: 'cam' })
    expect(pc.inits[1]).toMatchObject({
      sendEncodings: [{ maxBitrate: 800_000, maxFramerate: 30 }],
    })
    // The camera keeps the browser's own degradation (already balanced for cameras)
    expect(pc.transceivers[1].sender!.setParameters).not.toHaveBeenCalled()

    // Audio: the browser's defaults, and the answer as the SFU sent it
    await transport.publish(track, { kind: 'mic' })
    expect(pc.inits[2]).toEqual({ direction: 'sendonly', sendEncodings: undefined })
    expect(pc.remoteDescriptions[2].sdp).toBe(answer)
  })

  it('replaces what a published track sends without another SFU call (B2)', async () => {
    const { transport, pc, calls } = setup({
      'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
      'POST /api/sfu/abcdefghij/sessions/me/tracks': {
        sessionDescription: { type: 'answer', sdp: 'sfu-answer' },
        tracks: [{ mid: '0', trackName: 'x' }],
      },
    })
    await transport.connect()
    const published = await transport.publish(track, { kind: 'mic' })
    const other = { kind: 'audio' } as MediaStreamTrack
    await transport.replaceTrack(published.trackName, other)
    await transport.replaceTrack(published.trackName, null)
    expect(pc.transceivers[0].sender!.replaceTrack.mock.calls).toEqual([[other], [null]])
    expect(calls).toHaveLength(2)
    await expect(transport.replaceTrack('nope', null)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('pulls a remote track and answers the SFU offer with renegotiate', async () => {
    const { transport, calls } = setup({
      'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
      'POST /api/sfu/abcdefghij/sessions/me/tracks': {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'pull-mid-3' },
        tracks: [{ mid: '3', sessionId: 'them', trackName: 'cam-1' }],
      },
      'PUT /api/sfu/abcdefghij/sessions/me/renegotiate': {},
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
      url: '/api/sfu/abcdefghij/sessions/me/renegotiate',
      body: { sessionDescription: { type: 'answer', sdp: 'answer' } },
    })
  })

  it('answers the renegotiation the SFU asks for even when the pulled track failed (e2-t10)', async () => {
    const { transport, pc, calls } = setup({
      'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
      'POST /api/sfu/abcdefghij/sessions/me/tracks': {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'sfu-offer' },
        tracks: [
          { mid: '', sessionId: 'them', trackName: 'mic-1', errorCode: 'empty_track_error' },
        ],
      },
      'PUT /api/sfu/abcdefghij/sessions/me/renegotiate': {},
    })
    await transport.connect()
    await expect(
      transport.subscribe({ sessionId: 'them', trackName: 'mic-1' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    // Otherwise the session would refuse every later push or pull
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain(
      'PUT /api/sfu/abcdefghij/sessions/me/renegotiate',
    )
    expect(pc.signalingState).toBe('stable')
  })

  it('fails when the SFU says the session is gone, so that it gets rebuilt (e2-t10)', async () => {
    const { transport } = setup(
      {
        'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
        'POST /api/sfu/abcdefghij/sessions/me/tracks': {
          errorCode: 'session_error',
          errorDescription: 'Session appears to be disconnected.',
        },
      },
      { 'POST /api/sfu/abcdefghij/sessions/me/tracks': 410 },
    )
    await transport.connect()
    const states: string[] = []
    transport.on('state', (state) => states.push(state))
    await expect(
      transport.subscribe({ sessionId: 'them', trackName: 'cam-1' }),
    ).rejects.toMatchObject({ code: 'sfu_error' })
    expect(transport.state).toBe('failed')
    expect(states).toEqual(['failed'])
  })

  it('closes a subscription with a negotiated tracks/close', async () => {
    const { transport, pc, calls } = setup({
      'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
      'POST /api/sfu/abcdefghij/sessions/me/tracks': {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'pull-mid-3' },
        tracks: [{ mid: '3' }],
      },
      'PUT /api/sfu/abcdefghij/sessions/me/renegotiate': {},
      'PUT /api/sfu/abcdefghij/sessions/me/tracks/close': {
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
      'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
      'POST /api/sfu/abcdefghij/sessions/me/tracks': {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'pull-mid-3' },
        tracks: [{ mid: '3' }],
      },
      'PUT /api/sfu/abcdefghij/sessions/me/renegotiate': {},
      'PUT /api/sfu/abcdefghij/sessions/me/tracks/update': { tracks: [{ mid: '3' }] },
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
      'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
      'POST /api/sfu/abcdefghij/sessions/me/tracks': { tracks: [{ errorCode: 'track_not_found' }] },
    })
    await transport.connect()
    await expect(transport.subscribe({ sessionId: 'x', trackName: 'y' })).rejects.toMatchObject({
      code: 'not_found',
    })

    const unconfigured = new CloudflareRealtimeTransport({
      apiBase: '/api/sfu/abcdefghij',
      token: () => TOKEN,
      fetch: async () => Response.json({ error: 'sfu_not_configured' }, { status: 503 }),
      createPeerConnection: () => new MockPc() as unknown as RTCPeerConnection,
    })
    await expect(unconfigured.connect()).rejects.toMatchObject({ code: 'sfu_not_configured' })
    expect(unconfigured.state).toBe('failed')
  })

  it("sends the member's session token on every call to the proxy", async () => {
    const { transport, auth } = setup({
      'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
      'POST /api/sfu/abcdefghij/sessions/me/tracks': {
        sessionDescription: { type: 'answer', sdp: 'sfu-answer' },
        tracks: [{ mid: '0' }],
      },
    })
    await transport.connect()
    await transport.publish(track, { kind: 'mic' })
    expect(auth).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`])
  })

  it("maps the proxy's refusals to typed errors", async () => {
    const refused = (error: string, status: number) =>
      setup(
        { 'POST /api/sfu/abcdefghij/sessions': { error } },
        { 'POST /api/sfu/abcdefghij/sessions': status },
      ).transport.connect()
    await expect(refused('unauthorized', 401)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(refused('forbidden', 403)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(refused('upstream_error', 502)).rejects.toMatchObject({ code: 'sfu_error' })
  })

  it('takes a refused camera back: quota_exceeded, and the sender is stopped', async () => {
    const { transport, pc } = setup(
      {
        'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' },
        'POST /api/sfu/abcdefghij/sessions/me/tracks': { error: 'usage_audio_only' },
      },
      { 'POST /api/sfu/abcdefghij/sessions/me/tracks': 403 },
    )
    await transport.connect()
    await expect(
      transport.publish({ kind: 'video' } as MediaStreamTrack, { kind: 'cam' }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' })
    expect(pc.transceivers[0].stop).toHaveBeenCalled()
    expect(pc.signalingState).toBe('stable')
  })

  it('summarises the selected candidate pair, including TURN use', async () => {
    const { transport } = setup({ 'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' } })
    await transport.connect()
    expect(await transport.getStats()).toEqual({
      rttMs: 42,
      usingRelay: true,
      bytesSent: 10,
      bytesReceived: 20,
    })
  })

  it('closes the PeerConnection and refuses further calls', async () => {
    const { transport, pc } = setup({ 'POST /api/sfu/abcdefghij/sessions': { sessionId: 'me' } })
    await transport.connect()
    await transport.close()
    expect(pc.closed).toBe(true)
    await expect(transport.publish(track, { kind: 'mic' })).rejects.toMatchObject({
      code: 'closed',
    })
  })
})
