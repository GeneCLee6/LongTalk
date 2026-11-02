import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, MemberTrack } from '../../../shared/protocol.ts'
import { CloudflareRealtimeTransport } from '../../../src/media/CloudflareRealtimeTransport.ts'
import { RoomMedia } from '../../../src/room/RoomMedia.ts'

// Rooms of three or more (the fix after C1): a scripted stand-in for the Realtime SFU that keeps
// the rules the real one enforces, so the races that lost video between members show up without
// a browser:
// - one mutation at a time per session: a call that overlaps another, or arrives while the
//   session waits for our answer to its offer, gets 406 (Realtime: "expecting a remote answer");
// - a pushed track carries no packets until its sender has sent some; pulling it before that
//   asks for a renegotiation and fails the track with empty_track_error;
// - a pulled track goes on a mid the SFU picks, given in the result for that track.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** How long the scripted SFU takes per call, and a new sender takes to send its first packets */
const LATENCY_MS = 3
let firstPacketsMs = 30

interface TracksBody {
  tracks: { location?: string; mid?: string; sessionId?: string; trackName?: string }[]
}

interface MockTransceiver {
  mid: string | null
  stop: () => void
  receiver: { track: unknown }
  sender?: { start: () => void }
}

interface SfuSession {
  busy: boolean
  awaitingAnswer: boolean
  nextMid: number
}

class ScriptedSfu {
  readonly sessions = new Map<string, SfuSession>()
  /** Pushed tracks by `session/trackName`, and whether packets have arrived for them */
  readonly tracks = new Map<string, { sending: boolean }>()
  readonly log: string[] = []
  /** Calls answered with 406 */
  conflicts = 0
  /** Next pull answers with a top-level error, but still with an offer to answer */
  failNextPullWithOffer = false
  #nextSession = 1

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = (init?.body ? JSON.parse(String(init.body)) : { tracks: [] }) as TracksBody
    const match = /\/sessions(?:\/([^/]+)(\/.*)?)?$/.exec(url)!
    if (!match[1]) {
      const sessionId = `s${this.#nextSession++}`
      this.sessions.set(sessionId, { busy: false, awaitingAnswer: false, nextMid: 0 })
      return Response.json({ sessionId }, { status: 201 })
    }
    const session = this.sessions.get(match[1])!
    const route = `${method} ${match[2]}`
    if (session.busy || (session.awaitingAnswer && route !== 'PUT /renegotiate')) {
      this.conflicts += 1
      this.log.push(`${match[1]} 406 ${route}`)
      return Response.json(
        { errorCode: 'invalid_session_description', errorDescription: 'expecting a remote answer' },
        { status: 406 },
      )
    }
    session.busy = true
    try {
      await sleep(LATENCY_MS)
      return this.#handle(match[1], session, route, body)
    } finally {
      session.busy = false
    }
  }

  #handle(sessionId: string, session: SfuSession, route: string, body: TracksBody): Response {
    if (route === 'PUT /renegotiate') {
      session.awaitingAnswer = false
      this.log.push(`${sessionId} renegotiate`)
      return Response.json({})
    }
    if (route === 'PUT /tracks/close') {
      return Response.json({ sessionDescription: { type: 'answer', sdp: 'closed' }, tracks: [] })
    }
    const [track] = body.tracks
    if (track.location === 'local') {
      const key = `${sessionId}/${track.trackName}`
      const pushed = { sending: false }
      this.tracks.set(key, pushed)
      // Packets reach the SFU once the browser's sender starts, a moment after the answer
      setTimeout(() => (pushed.sending = true), firstPacketsMs)
      this.log.push(`${sessionId} push ${track.trackName}`)
      return Response.json({
        sessionDescription: { type: 'answer', sdp: 'sfu-answer' },
        tracks: [{ mid: track.mid, trackName: track.trackName }],
      })
    }
    const pushed = this.tracks.get(`${track.sessionId}/${track.trackName}`)
    const ref = { sessionId: track.sessionId, trackName: track.trackName }
    if (!pushed) {
      this.log.push(`${sessionId} pull ${track.trackName} not_found_track_error`)
      return Response.json({ tracks: [{ ...ref, errorCode: 'not_found_track_error' }] })
    }
    session.awaitingAnswer = true
    if (this.failNextPullWithOffer) {
      this.failNextPullWithOffer = false
      this.log.push(`${sessionId} pull ${track.trackName} backend_error`)
      return Response.json(
        {
          errorCode: 'backend_error',
          requiresImmediateRenegotiation: true,
          sessionDescription: { type: 'offer', sdp: 'sfu-offer' },
        },
        { status: 503 },
      )
    }
    if (!pushed.sending) {
      this.log.push(`${sessionId} pull ${track.trackName} empty_track_error`)
      return Response.json({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'sfu-offer' },
        tracks: [{ ...ref, mid: '', errorCode: 'empty_track_error' }],
      })
    }
    const mid = `r${session.nextMid++}`
    this.log.push(`${sessionId} pull ${track.trackName} ok`)
    return Response.json({
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: 'offer', sdp: `pull-mid-${mid}` },
      tracks: [{ ...ref, mid }],
    })
  }
}

/** Enough of RTCPeerConnection for the transport, with senders that start sending after a moment */
class MockPc {
  transceivers: MockTransceiver[] = []
  localDescription: { type: string; sdp: string } | null = null
  iceGatheringState = 'complete'
  signalingState = 'stable'
  connectionState = 'connected'
  #nextMid = 0

  addEventListener() {}
  removeEventListener() {}
  addTransceiver(track: unknown) {
    let sendingSince: number | null = null
    const t = {
      mid: null as string | null,
      stop: vi.fn(),
      receiver: { track: { local: track } },
      sender: {
        replaceTrack: vi.fn(async () => {}),
        start: () => (sendingSince ??= Date.now()),
        getStats: async () =>
          new Map([
            [
              'o',
              {
                type: 'outbound-rtp',
                bytesSent:
                  sendingSince !== null && Date.now() - sendingSince >= firstPacketsMs ? 1200 : 0,
              },
            ],
          ]),
      },
    }
    this.transceivers.push(t)
    return t
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer' }
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
    if (d.type === 'answer' && this.signalingState !== 'have-local-offer') {
      throw new Error('InvalidStateError: no local offer')
    }
    if (d.type === 'offer' && this.signalingState === 'have-local-offer') {
      throw new Error('InvalidStateError: glare')
    }
    this.signalingState = d.type === 'answer' ? 'stable' : 'have-remote-offer'
    if (d.type === 'answer') for (const t of this.transceivers) t.sender?.start()
    const pulled = /pull-mid-(\w+)/.exec(d.sdp)
    if (pulled) {
      this.transceivers.push({
        mid: pulled[1],
        stop: vi.fn(),
        receiver: { track: { remote: pulled[1] } },
      })
    }
  }
  getTransceivers() {
    return this.transceivers
  }
  close() {}
}

function transport(sfu: ScriptedSfu) {
  return new CloudflareRealtimeTransport({
    apiBase: '/api/sfu/abcdefghij',
    token: () => 'T'.repeat(43),
    fetch: sfu.fetch,
    createPeerConnection: () => new MockPc() as unknown as RTCPeerConnection,
  })
}

const audio = { kind: 'audio' } as MediaStreamTrack
const video = { kind: 'video' } as MediaStreamTrack

afterEach(() => {
  vi.useRealTimers()
  firstPacketsMs = 30
})

describe('CloudflareRealtimeTransport in a busy room', () => {
  it('runs concurrent pulls and pushes one SDP exchange at a time', async () => {
    const sfu = new ScriptedSfu()
    const alice = transport(sfu)
    await alice.connect()
    const mic = await alice.publish(audio, { kind: 'mic' })
    const cam = await alice.publish(video, { kind: 'cam' })
    const bob = transport(sfu)
    await bob.connect()
    // A room snapshot and a join notification at once: pulls and Bob's own pushes interleave
    const results = await Promise.all([
      bob.subscribe(mic),
      bob.publish(audio, { kind: 'mic' }),
      bob.subscribe(cam),
      bob.subscribe(mic),
      bob.publish(video, { kind: 'cam' }),
    ])
    expect(sfu.conflicts).toBe(0)
    // Each pulled track on the transceiver of its own result
    expect(results[0]).toMatchObject({ trackName: mic.trackName, track: { remote: 'r0' } })
    expect(results[2]).toMatchObject({ trackName: cam.trackName, track: { remote: 'r1' } })
    expect(results[3]).toEqual(results[0])
    expect(sfu.log.filter((l) => l.startsWith('s2'))).toEqual([
      `s2 pull ${mic.trackName} ok`,
      's2 renegotiate',
      expect.stringMatching(/^s2 push mic-/),
      `s2 pull ${cam.trackName} ok`,
      's2 renegotiate',
      expect.stringMatching(/^s2 push cam-/),
    ])
  })

  it('offers only VP8 for video it sends, so the answer keeps the offer payload types', async () => {
    const codecs = [
      { mimeType: 'video/H264', clockRate: 90000 },
      { mimeType: 'video/VP8', clockRate: 90000 },
      { mimeType: 'video/rtx', clockRate: 90000 },
      { mimeType: 'video/VP9', clockRate: 90000 },
    ]
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs, headerExtensions: [] }) })
    const preferences: unknown[] = []
    const pc = new MockPc()
    const addTransceiver = pc.addTransceiver.bind(pc)
    pc.addTransceiver = (track: unknown) =>
      Object.assign(addTransceiver(track), {
        setCodecPreferences: (c: unknown) => preferences.push(c),
      })
    const sfu = new ScriptedSfu()
    const alice = new CloudflareRealtimeTransport({
      apiBase: '/api/sfu/abcdefghij',
      token: () => 'T'.repeat(43),
      fetch: sfu.fetch,
      createPeerConnection: () => pc as unknown as RTCPeerConnection,
    })
    await alice.connect()
    await alice.publish(audio, { kind: 'mic' })
    await alice.publish(video, { kind: 'cam' })
    vi.unstubAllGlobals()
    expect(preferences).toEqual([[codecs[1], codecs[2]]])
  })

  it('publishes a screen as VP8 like a camera, after pulling others, and others pull it (D1)', async () => {
    const codecs = [
      { mimeType: 'video/H264', clockRate: 90000 },
      { mimeType: 'video/VP8', clockRate: 90000 },
      { mimeType: 'video/rtx', clockRate: 90000 },
    ]
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs, headerExtensions: [] }) })
    const preferences: unknown[] = []
    const pc = new MockPc()
    const addTransceiver = pc.addTransceiver.bind(pc)
    pc.addTransceiver = (track: unknown) =>
      Object.assign(addTransceiver(track), {
        setCodecPreferences: (c: unknown) => preferences.push(c),
      })
    const sfu = new ScriptedSfu()
    const alice = transport(sfu)
    await alice.connect()
    const cam = await alice.publish(video, { kind: 'cam' })
    const bob = new CloudflareRealtimeTransport({
      apiBase: '/api/sfu/abcdefghij',
      token: () => 'T'.repeat(43),
      fetch: sfu.fetch,
      createPeerConnection: () => pc as unknown as RTCPeerConnection,
    })
    await bob.connect()
    // Bob already receives a camera when he starts sharing: the case VP8-only exists for
    await bob.subscribe(cam)
    const screen = await bob.publish(video, { kind: 'screen' })
    vi.unstubAllGlobals()
    expect(screen.trackName).toMatch(/^screen-/)
    expect(preferences).toEqual([[codecs[1], codecs[2]]])
    const carol = transport(sfu)
    await carol.connect()
    await expect(carol.subscribe(screen)).resolves.toMatchObject({ trackName: screen.trackName })
    // Stopping the share closes its transceiver on the SFU, and the session stays usable
    await bob.unpublish(screen.trackName)
    await expect(bob.publish(audio, { kind: 'mic' })).resolves.toBeTruthy()
    expect(sfu.conflicts).toBe(0)
  })

  it('hands a published track back only once it sends, so the first pull of it works', async () => {
    const sfu = new ScriptedSfu()
    const alice = transport(sfu)
    const bob = transport(sfu)
    await Promise.all([alice.connect(), bob.connect()])
    const cam = await alice.publish(video, { kind: 'cam' })
    // Reported to the room now: everyone pulls it at once
    await expect(bob.subscribe(cam)).resolves.toMatchObject({ track: { remote: 'r0' } })
    expect(sfu.log).not.toContainEqual(expect.stringContaining('empty_track_error'))
  })

  it('fails (to be rebuilt) when a published track never sends: the connection never came up', async () => {
    firstPacketsMs = 60_000
    const sfu = new ScriptedSfu()
    const alice = new CloudflareRealtimeTransport({
      apiBase: '/api/sfu/abcdefghij',
      token: () => 'T'.repeat(43),
      fetch: sfu.fetch,
      createPeerConnection: () => new MockPc() as unknown as RTCPeerConnection,
      firstPacketsTimeoutMs: 300,
    })
    await alice.connect()
    await expect(alice.publish(video, { kind: 'cam' })).rejects.toMatchObject({
      code: 'negotiation_failed',
    })
    expect(alice.state).toBe('failed')
  })

  it('answers the SFU offer that comes with a failed pull, and keeps the session usable', async () => {
    const sfu = new ScriptedSfu()
    const alice = transport(sfu)
    const bob = transport(sfu)
    await Promise.all([alice.connect(), bob.connect()])
    const mic = await alice.publish(audio, { kind: 'mic' })
    sfu.failNextPullWithOffer = true
    await expect(bob.subscribe(mic)).rejects.toMatchObject({ code: 'sfu_error' })
    expect(sfu.log.at(-1)).toBe('s2 renegotiate')
    // Not wedged: the next call is not refused with 406
    await expect(bob.subscribe(mic)).resolves.toMatchObject({ trackName: mic.trackName })
    await expect(bob.publish(audio, { kind: 'mic' })).resolves.toBeTruthy()
    expect(sfu.conflicts).toBe(0)
    expect(bob.state).toBe('connected')
  })

  it('pulls of a track that has no packets yet fail as "not there yet", then work', async () => {
    const sfu = new ScriptedSfu()
    const bob = transport(sfu)
    await bob.connect()
    // Pushed by a client that did not wait for its first packets
    sfu.sessions.set('early', { busy: false, awaitingAnswer: false, nextMid: 0 })
    const pushed = { sending: false }
    sfu.tracks.set('early/cam-1', pushed)
    const ref = { sessionId: 'early', trackName: 'cam-1' }
    await expect(bob.subscribe(ref)).rejects.toMatchObject({ code: 'not_found' })
    expect(bob.state).toBe('connected')
    pushed.sending = true
    await expect(bob.subscribe(ref)).resolves.toMatchObject({ track: { remote: 'r0' } })
    expect(sfu.conflicts).toBe(0)
  })

  it('fails (to be rebuilt) when the SFU still expects an answer: 406', async () => {
    const sfu = new ScriptedSfu()
    const bob = transport(sfu)
    await bob.connect()
    sfu.sessions.get('s1')!.awaitingAnswer = true
    await expect(bob.publish(audio, { kind: 'mic' })).rejects.toMatchObject({ code: 'sfu_error' })
    expect(bob.state).toBe('failed')
  })

  it('fails (to be rebuilt) when the answer to an SFU offer is not accepted', async () => {
    const sfu = new ScriptedSfu()
    const alice = transport(sfu)
    await alice.connect()
    const mic = await alice.publish(audio, { kind: 'mic' })
    const bob = new CloudflareRealtimeTransport({
      apiBase: '/api/sfu/abcdefghij',
      token: () => 'T'.repeat(43),
      fetch: async (input, init) =>
        String(input).endsWith('/renegotiate')
          ? Response.json({ errorCode: 'internal_error' }, { status: 500 })
          : sfu.fetch(input, init),
      createPeerConnection: () => new MockPc() as unknown as RTCPeerConnection,
    })
    await bob.connect()
    await expect(bob.subscribe(mic)).rejects.toMatchObject({ code: 'sfu_error' })
    expect(bob.state).toBe('failed')
  })

  it('fails (to be rebuilt) when the SFU puts a pulled track on a mid it never offered', async () => {
    vi.useFakeTimers()
    const bob = new CloudflareRealtimeTransport({
      apiBase: '/api/sfu/abcdefghij',
      token: () => 'T'.repeat(43),
      fetch: async (input) =>
        String(input).endsWith('/sessions')
          ? Response.json({ sessionId: 's1' })
          : Response.json({
              requiresImmediateRenegotiation: false,
              tracks: [{ sessionId: 'them', trackName: 'cam-1', mid: '7' }],
            }),
      createPeerConnection: () => new MockPc() as unknown as RTCPeerConnection,
    })
    await bob.connect()
    const pulled = bob.subscribe({ sessionId: 'them', trackName: 'cam-1' })
    const settled = expect(pulled).rejects.toMatchObject({ code: 'negotiation_failed' })
    await vi.advanceTimersByTimeAsync(5_000)
    await settled
    expect(bob.state).toBe('failed')
  })
})

describe('RoomMedia: three members joining a few moments apart', () => {
  async function room(names: string[], gapMs: number) {
    const sfu = new ScriptedSfu()
    // RoomDO's part: each member's last `tracks`, handed to everyone else
    const listed = new Map<string, MemberTrack[]>()
    const members: { name: string; media: RoomMedia }[] = []
    const broadcast = () => {
      for (const m of members) {
        m.media.setDesired([...listed].filter(([name]) => name !== m.name).flatMap(([, t]) => t))
      }
    }
    const join = (name: string) => {
      const media = new RoomMedia({
        createTransport: () => transport(sfu),
        send: (message: ClientMessage) => {
          if (message.t !== 'tracks') return
          listed.set(
            name,
            message.tracks.map((t) => ({ sessionId: message.sessionId, ...t })),
          )
          // Delivered after the current call, like a WebSocket message
          setTimeout(broadcast, 0)
        },
        retryDelayMs: 20,
        retryMaxMs: 100,
      })
      members.push({ name, media })
      broadcast()
      return media.start({ mic: audio, cam: video })
    }
    await Promise.all(names.map((name, i) => sleep(i * gapMs).then(() => join(name))))
    const others = (names.length - 1) * 2
    await vi.waitFor(
      () => {
        for (const m of members) {
          expect(Object.keys(m.media.getState().received), m.name).toHaveLength(others)
        }
      },
      { timeout: 4_000 },
    )
    for (const m of members) {
      expect(m.media.getState()).toMatchObject({ status: 'connected', error: null })
    }
    await Promise.all(members.map((m) => m.media.close()))
    return sfu
  }

  it('everyone receives everyone, with no refused call', async () => {
    const sfu = await room(['Alice', 'Bob', 'Carol'], 10)
    expect(sfu.conflicts).toBe(0)
  })

  it('also when first packets are slow (a loaded machine, TURN): nobody gives up', async () => {
    // Longer than a few quick retries take: before the fix the subscribers gave up on the camera
    firstPacketsMs = 300
    const sfu = await room(['Alice', 'Bob', 'Carol', 'Dave'], 5)
    expect(sfu.conflicts).toBe(0)
  })
})
