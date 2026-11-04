// I4 (e8-t01, e8-t03; AC-8.1): the local recorder's pieces with fakes: the format chosen by asking
// MediaRecorder, the file name, the layout on the canvas (shared/layout.ts), the mixer and the
// composer keeping one source per track, the IndexedDB segment store and its recovery, and the
// whole pipeline (chunks written as they come, the file downloaded when it stops).
import { describe, expect, it, vi } from 'vitest'
import {
  fileExtension,
  pickMimeType,
  recordingFileName,
  VIDEO_TYPES,
} from '../../src/record/format.ts'
import {
  Composer,
  type Context2D,
  type FrameSource,
  type VideoFactory,
} from '../../src/record/composer.ts'
import { AudioMixer, type MixerContext } from '../../src/record/mixer.ts'
import {
  RECORDER_TIMESLICE_MS,
  RecorderError,
  startRecording,
  type RecorderDeps,
  type RecorderLike,
} from '../../src/record/recorder.ts'
import {
  EMPTY_SCENE,
  fitVideo,
  placeScene,
  withoutOwnCamera,
  type Scene,
  type SceneTile,
} from '../../src/record/scene.ts'
import {
  DOWNLOADED_KEEP_MS,
  LEFT_BEHIND_MS,
  MemoryBackend,
  PENDING_KEY,
  RecordingStore,
  recordingPending,
} from '../../src/record/store.ts'
import { fixDuration, withDuration } from '../../src/record/webmDuration.ts'

const track = (id: string, kind: 'audio' | 'video' = 'video') =>
  ({ id, kind, readyState: 'live', stop: vi.fn() }) as unknown as MediaStreamTrack

const tile = (id: string, extra: Partial<SceneTile> = {}): SceneTile => ({
  id,
  name: id,
  video: null,
  micMuted: false,
  you: false,
  ...extra,
})

describe('recording formats (e8-t03)', () => {
  it('picks the first type the browser records: WebM where it can, MP4 on Safari', () => {
    const chrome = (type: string) => type.startsWith('video/webm') || type.startsWith('audio/webm')
    expect(pickMimeType(chrome, false)).toBe('video/webm;codecs=vp9,opus')
    expect(pickMimeType(chrome, true)).toBe('audio/webm;codecs=opus')
    const firefox = (type: string) => type === 'video/webm;codecs=vp8,opus' || type === 'audio/webm'
    expect(pickMimeType(firefox, false)).toBe('video/webm;codecs=vp8,opus')
    expect(pickMimeType(firefox, true)).toBe('audio/webm')
    const safari = (type: string) => type.includes('mp4')
    expect(pickMimeType(safari, false)).toBe('video/mp4;codecs=avc1,mp4a.40.2')
    expect(pickMimeType(safari, true)).toBe('audio/mp4;codecs=mp4a.40.2')
    expect(pickMimeType(() => false, false)).toBeNull()
    // A browser that throws on a type it cannot parse just does not have it
    const picky = (type: string) => {
      if (type.includes('vp9')) throw new Error('bad type')
      return true
    }
    expect(pickMimeType(picky, false)).toBe(VIDEO_TYPES[1])
  })

  it('names the file after the room and the time it started, safe for every file system', () => {
    const at = new Date(2026, 10, 4, 15, 30)
    expect(recordingFileName('週五聊天', at, 'video/webm;codecs=vp9,opus')).toBe(
      'LongTalk 週五聊天 2026-11-04 15-30.webm',
    )
    expect(recordingFileName('a/b:c*?"<>|d', at, 'video/mp4')).toBe(
      'LongTalk a b c d 2026-11-04 15-30.mp4',
    )
    expect(recordingFileName('', at, 'audio/mp4')).toBe('LongTalk 2026-11-04 15-30.m4a')
    expect(recordingFileName('x'.repeat(100), at, 'audio/webm')).toHaveLength(
      'LongTalk '.length + 60 + ' 2026-11-04 15-30.webm'.length,
    )
    expect(fileExtension('audio/webm;codecs=opus')).toBe('webm')
  })
})

describe('the recording layout (e8-t01, shared/layout.ts)', () => {
  const within = (rect: { x: number; y: number; width: number; height: number }) =>
    rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1280 && rect.y + rect.height <= 720

  it('lays the gallery out like the stage: one big tile, then a grid, all inside the canvas', () => {
    expect(placeScene(EMPTY_SCENE, 1280, 720)).toEqual([])
    const one = placeScene({ ...EMPTY_SCENE, tiles: [tile('a')] }, 1280, 720)
    expect(one).toHaveLength(1)
    expect(one[0].rect.width / one[0].rect.height).toBeCloseTo(16 / 9, 1)
    const five = placeScene(
      { ...EMPTY_SCENE, tiles: ['a', 'b', 'c', 'd', 'e'].map((id) => tile(id)) },
      1280,
      720,
    )
    expect(five).toHaveLength(5)
    expect(five.every((p) => within(p.rect))).toBe(true)
    // Same size, in rows; the last row is centred
    expect(new Set(five.map((p) => p.rect.width)).size).toBe(1)
    const rows = [...new Set(five.map((p) => p.rect.y))]
    expect(rows).toHaveLength(2)
  })

  it('shows the focus big with the others in a row under it (演講者, a pin, the spotlight)', () => {
    const scene: Scene = {
      ...EMPTY_SCENE,
      tiles: ['a', 'b', 'c'].map((id) => tile(id)),
      layout: 'speaker',
      focus: 'b',
    }
    const [big, ...strip] = placeScene(scene, 1280, 720)
    expect(big.kind === 'tile' && big.tile.id).toBe('b')
    expect(strip.map((p) => p.kind === 'tile' && p.tile.id)).toEqual(['a', 'c'])
    expect(big.rect.width).toBeGreaterThan(strip[0].rect.width * 2)
    // The row is under the big tile
    expect(strip.every((p) => p.rect.y >= big.rect.y + big.rect.height)).toBe(true)
    expect([big, ...strip].every((p) => within(p.rect))).toBe(true)
  })

  it('puts a share in the main area and the people beside it, leaving out who does not fit', () => {
    const share = { id: 's', name: 'Sam', video: track('screen') }
    const scene: Scene = { ...EMPTY_SCENE, share, tiles: ['a', 'b'].map((id) => tile(id)) }
    const [main, ...people] = placeScene(scene, 1280, 720)
    expect(main.kind).toBe('share')
    expect(main.rect.width).toBeGreaterThan(900)
    expect(people).toHaveLength(2)
    // A strip on the right of a wide canvas
    expect(people.every((p) => p.rect.x >= main.rect.x + main.rect.width)).toBe(true)
    const crowd = placeScene(
      { ...scene, tiles: Array.from({ length: 30 }, (_, i) => tile(`m${i}`)) },
      1280,
      720,
    )
    expect(crowd.length).toBeLessThan(31)
    expect(crowd.every((p) => within(p.rect))).toBe(true)
    // Alone with the share: the share takes it all
    expect(placeScene({ ...scene, tiles: [] }, 1280, 720)).toHaveLength(1)
  })

  it('crops cameras to fill and letterboxes shares', () => {
    const rect = { x: 0, y: 0, width: 160, height: 90 }
    expect(fitVideo(640, 480, rect, 'cover')).toEqual({
      source: { x: 0, y: 60, width: 640, height: 360 },
      target: rect,
    })
    expect(fitVideo(640, 480, rect, 'contain')?.target).toEqual({
      x: 20,
      y: 0,
      width: 120,
      height: 90,
    })
    expect(fitVideo(0, 0, rect, 'cover')).toBeNull()
  })

  it('leaves our own camera out when 包含我的鏡頭 is off, keeping our tile', () => {
    const camera = track('cam')
    const scene: Scene = {
      ...EMPTY_SCENE,
      tiles: [tile('me', { you: true, video: camera }), tile('b', { video: track('b') })],
    }
    const without = withoutOwnCamera(scene)
    expect(without.tiles.map((t) => t.video?.id ?? null)).toEqual([null, 'b'])
    expect(withoutOwnCamera(without)).toBe(without)
  })
})

describe('the mixer (e8-t01)', () => {
  function fakeContext() {
    const nodes: { stream: MediaStream; connected: boolean }[] = []
    const context: MixerContext = {
      createMediaStreamDestination: () => ({
        stream: { getAudioTracks: () => [track('mix', 'audio')] } as unknown as MediaStream,
      }),
      createMediaStreamSource: (stream) => {
        const node = { stream, connected: false }
        nodes.push(node)
        return {
          connect: () => {
            node.connected = true
          },
          disconnect: () => {
            node.connected = false
          },
        }
      },
    }
    return { context, nodes }
  }

  it('mixes exactly the tracks it is given, connecting each once and letting go of the gone', () => {
    const { context, nodes } = fakeContext()
    const mixer = new AudioMixer(context, (t) => ({ id: t.id }) as unknown as MediaStream)
    expect(mixer.track.id).toBe('mix')
    const a = track('a', 'audio')
    const b = track('b', 'audio')
    mixer.sync([a, b, track('v', 'video')])
    expect(mixer.size).toBe(2)
    // The same tracks again (every frame): nothing new
    for (let i = 0; i < 100; i++) mixer.sync([a, b])
    expect(nodes).toHaveLength(2)
    mixer.sync([b])
    expect(mixer.size).toBe(1)
    expect(nodes.filter((n) => n.connected)).toHaveLength(1)
    const ended = { ...track('c', 'audio'), readyState: 'ended' } as MediaStreamTrack
    mixer.sync([b, ended])
    expect(mixer.size).toBe(1)
    mixer.close()
    expect(nodes.filter((n) => n.connected)).toHaveLength(0)
  })
})

/** A 2D context that records what was drawn */
function fakeContext2D() {
  const calls: string[] = []
  const ctx = new Proxy(
    {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      textAlign: 'left',
      textBaseline: 'alphabetic',
    },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target]
        if (key === 'measureText') return (text: string) => ({ width: [...text].length * 8 })
        return (...args: unknown[]) => {
          calls.push(`${String(key)}${key === 'fillText' ? `:${String(args[0])}` : ''}`)
        }
      },
      set(target, key, value) {
        ;(target as Record<string, unknown>)[key as string] = value
        return true
      },
    },
  ) as unknown as Context2D
  return { ctx, calls }
}

function fakeVideos() {
  const opened = new Map<string, FrameSource>()
  const factory: VideoFactory = {
    open: (t) => {
      const source = { videoWidth: 640, videoHeight: 360, readyState: 4 }
      opened.set(t.id, source)
      return source
    },
    close: (source) => {
      for (const [id, s] of opened) if (s === source) opened.delete(id)
    },
  }
  return { factory, opened }
}

describe('the composer (e8-t01)', () => {
  it('draws each tile with its video or initial and nameplate, one video element per track', () => {
    const { ctx, calls } = fakeContext2D()
    const { factory, opened } = fakeVideos()
    const composer = new Composer(ctx, 1280, 720, factory)
    const cam = track('cam-b')
    const scene: Scene = {
      ...EMPTY_SCENE,
      tiles: [tile('Ada', { micMuted: true }), tile('Bob', { video: cam })],
    }
    for (let i = 0; i < 300; i++) composer.draw(scene)
    expect(opened.size).toBe(1)
    expect(composer.openVideos).toBe(1)
    const frame = calls.slice(-calls.length / 300)
    expect(frame.filter((c) => c === 'drawImage')).toHaveLength(1)
    // Ada's initial and both names
    expect(frame).toContain('fillText:A')
    expect(frame).toContain('fillText:Ada')
    expect(frame).toContain('fillText:Bob')
    // Bob turns the camera off: the element goes
    composer.draw({ ...scene, tiles: [tile('Ada'), tile('Bob')] })
    expect(opened.size).toBe(0)
    composer.draw({ ...scene, share: { id: 's', name: 'Sam', video: track('scr') } })
    expect(calls).toContain('fillText:Sam 的分享畫面')
    composer.dispose()
    expect(opened.size).toBe(0)
  })
})

describe('the segment store and recovery (e8-t01)', () => {
  const base = {
    roomId: 'abcdefghij',
    roomName: '週五聊天',
    startedAt: 1000,
    mimeType: 'video/webm',
    fileName: 'x.webm',
  }

  it('keeps chunks in order, puts the file together from them and cleans up once downloaded', async () => {
    localStorage.clear()
    let now = 1000
    const backend = new MemoryBackend()
    const store = new RecordingStore(backend, () => now)
    let meta = await store.create({ ...base, id: 'r1' })
    expect(recordingPending()).toBe(true)
    for (const part of ['a', 'bb', 'ccc']) {
      now += RECORDER_TIMESLICE_MS
      meta = await store.append(meta, new Blob([part]))
    }
    expect(meta).toMatchObject({ chunks: 3, bytes: 6, updatedAt: now })
    const file = await store.file(meta, 'video/webm')
    expect(file.type).toBe('video/webm')
    expect(await file.text()).toBe('abbccc')
    await store.markDownloaded(meta)
    // Not offered again; kept a while for the download, then gone
    expect(await store.leftovers(null)).toEqual([])
    now += DOWNLOADED_KEEP_MS - 1
    await store.cleanUp()
    expect(backend.metas.size).toBe(1)
    now += 1
    await store.cleanUp()
    expect(backend.metas.size).toBe(0)
    expect(backend.stored.size).toBe(0)
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
  })

  it('offers a recording left behind: by its lock where there are Web Locks, else by age', async () => {
    let now = 1000
    const store = new RecordingStore(new MemoryBackend(), () => now)
    const live = await store.append(await store.create({ ...base, id: 'live' }), new Blob(['x']))
    const lost = await store.append(
      await store.create({ ...base, id: 'lost', startedAt: 2000 }),
      new Blob(['y']),
    )
    await store.create({ ...base, id: 'empty' })
    // With locks: whatever no tab holds, at once (a reload comes back to its offer)
    expect((await store.leftovers(['live'])).map((m) => m.id)).toEqual(['lost'])
    // Without: only once nobody wrote to it for LEFT_BEHIND_MS
    expect(await store.leftovers(null)).toEqual([])
    now += LEFT_BEHIND_MS
    expect((await store.leftovers(null)).map((m) => m.id)).toEqual(['lost', 'live'])
    // An empty one left behind is simply deleted
    await store.cleanUp()
    expect((await store.leftovers(null)).map((m) => m.id)).toEqual([lost.id, live.id])
    await store.remove('lost')
    await store.remove('live')
    expect(recordingPending()).toBe(false)
  })
})

/** The recorder's world, faked: MediaRecorder hands over chunks when told */
function fakeDeps(overrides: Partial<RecorderDeps> = {}) {
  const backend = new MemoryBackend()
  let now = 5000
  const store = new RecordingStore(backend, () => now)
  const downloads: { blob: Blob; fileName: string }[] = []
  const recorders: (RecorderLike & { emit(text: string): void; options: unknown })[] = []
  let tick: (() => void) | null = null
  const later: (() => void)[] = []
  const held = new Set<string>()
  const { factory } = fakeVideos()
  const deps: RecorderDeps = {
    isTypeSupported: (type) => type.startsWith('video/webm') || type.startsWith('audio/webm'),
    createRecorder: (_stream, options) => {
      const recorder = {
        state: 'inactive' as RecorderLike['state'],
        ondataavailable: null as RecorderLike['ondataavailable'],
        onstop: null as RecorderLike['onstop'],
        onerror: null as RecorderLike['onerror'],
        options,
        start(timeslice: number) {
          expect(timeslice).toBe(RECORDER_TIMESLICE_MS)
          this.state = 'recording'
        },
        stop() {
          this.emit('end')
          this.state = 'inactive'
          queueMicrotask(() => this.onstop?.())
        },
        emit(text: string) {
          this.ondataavailable?.({ data: new Blob([text]) })
        },
      }
      recorders.push(recorder)
      return recorder
    },
    createAudioContext: () => ({
      createMediaStreamDestination: () => ({
        stream: { getAudioTracks: () => [track('mix', 'audio')] } as unknown as MediaStream,
      }),
      createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }),
      close: async () => {},
    }),
    createCanvas: () => ({
      getContext: () => fakeContext2D().ctx,
      captureStream: () => ({ getVideoTracks: () => [track('canvas')] }) as unknown as MediaStream,
    }),
    createStream: (tracks) => ({ tracks }) as unknown as MediaStream,
    trackStream: (t) => ({ id: t.id }) as unknown as MediaStream,
    videos: factory,
    openStore: async () => store,
    download: (blob, fileName) => downloads.push({ blob, fileName }),
    ticker: (_ms, fn) => {
      tick = fn
      return () => {
        tick = null
      }
    },
    newId: () => 'rec-1',
    now: () => now,
    later: (work) => later.push(work),
    hold: (id) => {
      held.add(id)
      return () => held.delete(id)
    },
    ...overrides,
  }
  return {
    deps,
    backend,
    store,
    downloads,
    recorders,
    held,
    later,
    tick: () => tick?.(),
    ticking: () => tick !== null,
    advance: (ms: number) => (now += ms),
  }
}

const options = (getScene = () => EMPTY_SCENE) => ({
  roomId: 'abcdefghij',
  roomName: '週五聊天',
  settings: { audioOnly: false, includeSelf: true, resolution: '720p' as const },
  getScene,
})

describe('the recorder pipeline (e8-t01)', () => {
  it('writes every chunk to the store as it comes, and downloads the whole file when stopped', async () => {
    const world = fakeDeps()
    const getScene = vi.fn(() => EMPTY_SCENE)
    const handle = await startRecording(options(getScene), world.deps)
    expect(handle.mimeType).toBe('video/webm;codecs=vp9,opus')
    expect(handle.fileName).toMatch(/^LongTalk 週五聊天 .*\.webm$/)
    expect(world.recorders[0].options).toEqual({
      mimeType: 'video/webm;codecs=vp9,opus',
      videoBitsPerSecond: 2_500_000,
      audioBitsPerSecond: 128_000,
    })
    expect(world.held.has('rec-1')).toBe(true)
    world.tick()
    world.tick()
    expect(getScene).toHaveBeenCalledTimes(3)
    world.recorders[0].emit('one ')
    world.recorders[0].emit('two ')
    await vi.waitFor(async () => expect((await world.backend.getMeta('rec-1'))?.chunks).toBe(2))
    const saved = await handle.stop()
    expect(saved.bytes).toBe('one two end'.length)
    expect(world.downloads).toHaveLength(1)
    expect(await world.downloads[0].blob.text()).toBe('one two end')
    expect(world.downloads[0].blob.type).toBe('video/webm')
    expect(world.ticking()).toBe(false)
    expect(world.held.size).toBe(0)
    // Stopping twice saves once
    await handle.stop()
    expect(world.downloads).toHaveLength(1)
    // The chunks go once the download had its time
    expect((await world.backend.getMeta('rec-1'))?.downloaded).toBe(true)
    world.advance(DOWNLOADED_KEEP_MS + 1000)
    for (const work of world.later) work()
    await vi.waitFor(() => expect(world.backend.metas.size).toBe(0))
  })

  it('records sound only without a canvas, at 1080p with the higher bitrate', async () => {
    const world = fakeDeps({
      createCanvas: () => {
        throw new Error('no canvas for sound only')
      },
    })
    const handle = await startRecording(
      { ...options(), settings: { audioOnly: true, includeSelf: true, resolution: '720p' } },
      world.deps,
    )
    expect(handle.mimeType).toBe('audio/webm;codecs=opus')
    expect(handle.fileName).toMatch(/\.webm$/)
    expect(world.recorders[0].options).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128_000,
    })
    await handle.stop()
    const hd = fakeDeps()
    await startRecording(
      { ...options(), settings: { audioOnly: false, includeSelf: false, resolution: '1080p' } },
      hd.deps,
    )
    expect(hd.recorders[0].options).toMatchObject({ videoBitsPerSecond: 5_000_000 })
  })

  it('refuses where the browser records no format, and when IndexedDB cannot open', async () => {
    await expect(
      startRecording(options(), fakeDeps({ isTypeSupported: () => false }).deps),
    ).rejects.toEqual(new RecorderError('unsupported'))
    await expect(
      startRecording(
        options(),
        fakeDeps({ openStore: () => Promise.reject(new Error('blocked')) }).deps,
      ),
    ).rejects.toEqual(new RecorderError('storage'))
  })

  it('stops by itself and saves what it has when storage runs out', async () => {
    const world = fakeDeps()
    const onProblem = vi.fn()
    const handle = await startRecording({ ...options(), onProblem }, world.deps)
    world.recorders[0].emit('kept ')
    await vi.waitFor(async () => expect((await world.backend.getMeta('rec-1'))?.chunks).toBe(1))
    const put = world.backend.putChunk.bind(world.backend)
    world.backend.putChunk = async () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    world.recorders[0].emit('lost')
    await vi.waitFor(() => expect(onProblem).toHaveBeenCalledWith('storage'))
    world.backend.putChunk = put
    const saved = await handle.stop()
    expect(saved.bytes).toBe('kept '.length)
    expect(await world.downloads[0].blob.text()).toBe('kept ')
  })

  it('deletes an empty recording instead of downloading nothing', async () => {
    const world = fakeDeps({
      createRecorder: () => ({
        state: 'inactive',
        ondataavailable: null,
        onstop: null,
        onerror: null,
        start() {},
        stop() {},
      }),
    })
    const handle = await startRecording(options(), world.deps)
    expect(await handle.stop()).toEqual({ fileName: handle.fileName, bytes: 0 })
    expect(world.downloads).toHaveLength(0)
    expect(world.backend.metas.size).toBe(0)
  })
})

describe('the WebM duration (e8-t01)', () => {
  const bytes = (...parts: (number[] | string)[]) =>
    Uint8Array.from(
      parts.flatMap((part) =>
        typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : part,
      ),
    )
  /** A WebM's start as MediaRecorder writes it: EBML header, a live Segment, Info, a Cluster */
  const live = (
    infoChildren: Uint8Array,
    segmentSize = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  ) =>
    bytes(
      [0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84],
      'webm',
      [0x18, 0x53, 0x80, 0x67, ...segmentSize],
      [0x15, 0x49, 0xa9, 0x66, 0x80 | infoChildren.length],
      [...infoChildren],
      [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xa3, 0x81, 0x00],
    )
  const scaleAndApp = bytes([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40], [0x4d, 0x80, 0x84], 'test')
  const durationIn = (file: Uint8Array) => {
    for (let i = 0; i + 11 <= file.length; i++) {
      if (file[i] === 0x44 && file[i + 1] === 0x89 && file[i + 2] === 0x88) {
        return new DataView(file.buffer, file.byteOffset + i + 3, 8).getFloat64(0)
      }
    }
    return null
  }

  it('adds the Duration to Info and keeps every other byte', async () => {
    const original = live(scaleAndApp)
    const fixed = withDuration(original, 61_500)!
    expect(fixed).not.toBeNull()
    expect(durationIn(fixed)).toBe(61_500)
    expect(fixed.length).toBe(original.length + 11)
    // Info's size grew by the 11 bytes of Duration
    const infoAt = fixed.findIndex((_, i) => fixed[i] === 0x15 && fixed[i + 1] === 0x49)
    expect(fixed[infoAt + 4]).toBe(0x80 | (scaleAndApp.length + 11))
    // The cluster after it is untouched
    expect([...fixed.subarray(-15)]).toEqual([...original.subarray(-15)])
    // A file that has one already, or is not WebM, is left as it is
    expect(withDuration(fixed, 1)).toBeNull()
    expect(withDuration(bytes([0, 0, 0, 0x20], 'ftypmp42'), 1)).toBeNull()
    // In ticks of the file's own timestamp scale
    const micro = bytes([0x2a, 0xd7, 0xb1, 0x83, 0x00, 0x03, 0xe8])
    expect(durationIn(withDuration(live(micro), 2_000)!)).toBe(2_000_000)
    // A Segment of known size grows with it
    const known = live(scaleAndApp, [0x40, 0x00 + scaleAndApp.length + 5 + 15])
    const grown = withDuration(known, 10)!
    expect(grown[known.length - (scaleAndApp.length + 5 + 15) - 1]).toBe(
      scaleAndApp.length + 5 + 15 + 11,
    )
    // The file's chunks: only a WebM's first one changes
    const chunks = [new Blob([original as BlobPart]), new Blob(['rest'])]
    const out = await fixDuration(chunks, 'video/webm;codecs=vp9,opus', 5000)
    expect(durationIn(new Uint8Array(await out[0].arrayBuffer()))).toBe(5000)
    expect(out[1]).toBe(chunks[1])
    expect(await fixDuration(chunks, 'video/mp4', 5000)).toBe(chunks)
  })
})
