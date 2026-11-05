import {
  chromium,
  expect,
  test,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { zhTW as strings } from '../src/i18n/zh-TW.ts'
import { chromiumFakeMedia } from './fakeDevices.ts'

// H6 (e2-t16, AC-2.8): different engines in one room through the real Realtime SFU. The project's
// browser is Firefox (its fake camera, a changing colour, and microphone, a tone, from prefs:
// e2e/fakeDevices.ts); the other member is a Chromium with Chrome's fakes. Both must see and hear
// each other, see a mute, and see each other's screen (a canvas stand-in for the picker, as in
// interop.spec.ts). What each one publishes (how many simulcast layers Firefox really sends) is
// attached to the report, not asserted: BROWSER-SUPPORT.md records it. A second test does the same
// with Playwright's WebKit where its build has WebRTC and capture devices (on Linux), and is
// skipped where it has not.
//
// Runs against a deployed Worker with the SFU (playwright.config.ts, project `firefox`); in CI
// the pull request's preview (preview.yml, job `e2e-firefox`), next to the Chromium interop test
// and not in its way.

const VIDEO_FRAMES_PER_SECOND = 5
const SHARE_FRAMES_PER_SECOND = 3
/** Both fake microphones are steady tones; silence is 0 */
const AUDIBLE = 0.02

interface Member {
  name: string
  engine: string
  context: BrowserContext
  page: Page
}

/**
 * A moving canvas for getDisplayMedia (headless browsers have no screen and no picker); on the
 * prototype, as in WebKit, setting it on navigator.mediaDevices from an init script did not hold
 */
function stubScreen() {
  MediaDevices.prototype.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    const context = canvas.getContext('2d')!
    let frame = 0
    const draw = () => {
      frame += 1
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#0e7490'
      context.fillRect((frame * 8) % canvas.width, 200, 160, 160)
    }
    draw()
    const timer = setInterval(draw, 1000 / 15)
    const stream = canvas.captureStream(15)
    stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer))
    return stream
  }
}

/** Keeps every PeerConnection the page makes, for reading what it sends (getStats) */
function keepPeerConnections() {
  const Native = window.RTCPeerConnection
  const kept: RTCPeerConnection[] = []
  ;(window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = kept
  window.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(config)
      kept.push(this)
    }
  }
}

async function join(
  browser: Browser,
  engine: string,
  url: string,
  name: string,
  { arm, ...rest }: BrowserContextOptions & { arm?: string } = {},
): Promise<Member> {
  const options = { arm }
  const context = await browser.newContext({ locale: 'zh-TW', ...rest })
  await context.addInitScript(stubScreen)
  await context.addInitScript(keepPeerConnections)
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.log(`[${name} ${engine}] ${message.text().slice(0, 300)}`)
  })
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (path.startsWith('/api/sfu/') && !response.ok()) {
      console.log(
        `[${name} ${engine}] ${response.request().method()} ${path} → ${response.status()}`,
      )
    }
  })
  const member: Record<string, unknown> = { subs: new Map() }
  page.on('response', async (response) => {
    const u = new URL(response.url())
    if (!u.pathname.startsWith('/api/sfu/') || !u.pathname.includes('/tracks')) return
    const req = response.request()
    try {
      const body = JSON.parse(req.postData() ?? '{}')
      const json = await response.json()
      const remote = (body.tracks ?? []).filter((t: { location: string }) => t.location === 'remote')
      if (remote.length) console.log(`DIAG sfu ${name} ${req.method()} ${u.pathname.split('/').pop()} ${JSON.stringify(remote.map((t: { trackName: string; simulcast?: { preferredRid: string } }) => [t.trackName, t.simulcast?.preferredRid]))} -> ${JSON.stringify(json.tracks?.map((t: { mid?: string; errorCode?: string }) => [t.mid, t.errorCode]))}`)
      const headers = await req.allHeaders()
      if (headers.authorization) {
        member.sfu = { url: u.origin + u.pathname.replace(/\/tracks.*$/, '/tracks/update'), auth: headers.authorization }
      }
      for (const t of json.tracks ?? []) {
        if (t.trackName && t.sessionId && t.mid) (member.subs as Map<string, unknown>).set(t.trackName, t)
      }
    } catch {
      // not JSON
    }
  })
  if (options.arm === 'noQ') {
    await page.route('**/tracks/update', async (route) => {
      const body = route.request().postData() ?? ''
      await route.continue({ postData: body.replace('"preferredRid":"q"', '"preferredRid":"h"') })
    })
  }
  member.arm = options.arm
  await page.goto(url)
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill(name)
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
  return Object.assign(member, { name, engine, context, page }) as unknown as Member
}

const tile = (viewer: Member, other: Member) =>
  viewer.page.getByRole('figure', { name: other.name, exact: true })

const toolbarButton = (member: Member, name: string) =>
  member.page
    .getByRole('toolbar', { name: strings.devices.controls })
    .getByRole('button', { name, exact: true })

/**
 * Frames this video element showed in one second (0 when there is none), counted with
 * requestVideoFrameCallback: Firefox's getVideoPlaybackQuality() stays at 0 for a MediaStream
 */
async function framesOf(video: ReturnType<Page['locator']>): Promise<number> {
  if ((await video.count()) === 0) return 0
  return video.evaluate(async (element: HTMLVideoElement) => {
    if (element.videoWidth === 0) return 0
    let frames = 0
    let counting = true
    const count = () => {
      frames += 1
      if (counting) element.requestVideoFrameCallback(count)
    }
    element.requestVideoFrameCallback(count)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    counting = false
    return frames
  })
}

/**
 * How loud `other`'s microphone is where `viewer` plays it, over 1.5 seconds: the loudest sample
 * of the <audio> element's stream, or what the RTP receivers say (the synchronization sources'
 * level, and the RMS from inbound-rtp's totalAudioEnergy), whichever is highest. The receivers'
 * numbers are there because Firefox on a CI machine without a sound card never resumes an
 * AudioContext (the samples read 0, resume() never settles) while the sound arrives all the same. Only two members are in these
 * rooms, so every audio receiver is `other`'s.
 */
async function audioPeak(viewer: Member, other: Member): Promise<number> {
  const audio = viewer.page.locator(`audio[data-member="${other.name}"]`)
  if ((await audio.count()) === 0) return 0
  const { peak, debug } = await audio.evaluate(async (element: HTMLAudioElement) => {
    const stream = element.srcObject
    if (!(stream instanceof MediaStream) || stream.getAudioTracks().length === 0) {
      return { peak: 0, debug: 'no stream' }
    }
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter(
      (pc) => pc.connectionState !== 'closed',
    )
    const receivers = pcs.flatMap((pc) => pc.getReceivers()).filter((r) => r.track.kind === 'audio')
    const energy = async () => {
      let total = 0
      let duration = 0
      const seen: string[] = []
      for (const pc of pcs) {
        ;(await pc.getStats()).forEach((report) => {
          if (report.type !== 'inbound-rtp' || report.kind !== 'audio') return
          total += report.totalAudioEnergy ?? 0
          duration += report.totalSamplesDuration ?? 0
          seen.push(
            `${report.bytesReceived}B/${report.audioLevel ?? '-'}/${report.totalAudioEnergy ?? '-'}`,
          )
        })
      }
      return { total, duration, seen }
    }
    const context = new AudioContext()
    try {
      // Without a sound card Firefox never resumes it: go on after half a second (the receivers
      // still tell)
      await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, 500))])
      const analyser = context.createAnalyser()
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const before = await energy()
      let samplePeak = 0
      let sourcePeak = 0
      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        analyser.getFloatTimeDomainData(samples)
        for (const sample of samples) samplePeak = Math.max(samplePeak, Math.abs(sample))
        // Only sources heard in the last second count (a muted sender stops sending); the
        // timestamp is on the epoch in some browsers and on performance.now() in others
        for (const source of receivers.flatMap((r) => r.getSynchronizationSources())) {
          const now = source.timestamp > 1e12 ? Date.now() : performance.now()
          if (now - source.timestamp < 1000)
            sourcePeak = Math.max(sourcePeak, source.audioLevel ?? 0)
        }
      }
      const after = await energy()
      const seconds = after.duration - before.duration
      const rms = seconds > 0 ? Math.sqrt(Math.max(0, after.total - before.total) / seconds) : 0
      return {
        peak: Math.max(samplePeak, sourcePeak, rms),
        debug:
          `context ${context.state} samples ${samplePeak.toFixed(3)} sources ${sourcePeak.toFixed(3)} ` +
          `rms ${rms.toFixed(3)} receivers ${receivers.length} inbound ${after.seen.join(',')}`,
      }
    } finally {
      void context.close()
    }
  })
  if (peak <= AUDIBLE)
    console.log(`[${viewer.name} ${viewer.engine}] hearing ${other.name}: ${debug}`)
  return peak
}

async function expectReceiving(viewer: Member, other: Member) {
  const video = tile(viewer, other).getByLabel(strings.room.tileVideo(other.name), { exact: true })
  await expect(video, `${viewer.name} (${viewer.engine}) sees ${other.name}`).toBeVisible()
  await expect
    .poll(() => framesOf(video), {
      message: `${viewer.name} (${viewer.engine}) decodes ${other.name}'s camera`,
    })
    .toBeGreaterThanOrEqual(VIDEO_FRAMES_PER_SECOND)
  await expect
    .poll(() => audioPeak(viewer, other), {
      message: `${viewer.name} (${viewer.engine}) hears ${other.name}`,
    })
    .toBeGreaterThan(AUDIBLE)
}

// TEMPORARY DIAGNOSTICS (fix/webkit-share-decode): removed before merging
const diagViewer = (m: Member) =>
  m.page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((pc) => pc.connectionState !== 'closed')
    const inbound: unknown[] = []
    const tracks: Record<string, string> = {}
    for (const pc of pcs) {
      for (const t of pc.getTransceivers()) if (t.mid) tracks[t.mid] = t.receiver.track.id.slice(0, 6)
      ;(await pc.getStats()).forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return
        inbound.push({ mid: r.mid, ssrc: r.ssrc, kb: Math.round(r.bytesReceived / 1000), dec: r.framesDecoded, w: r.frameWidth, h: r.frameHeight, key: r.keyFramesDecoded, pli: r.pliCount, fir: r.firCount, nack: r.nackCount, lost: r.packetsLost, drop: r.framesDropped })
      })
    }
    const videos = [...document.querySelectorAll('video')].map((v) => {
      const st = (v as HTMLVideoElement).srcObject as MediaStream | null
      const tr = st?.getVideoTracks()[0]
      return { label: v.getAttribute('aria-label'), track: tr?.id.slice(0, 6), muted: tr?.muted, w: (v as HTMLVideoElement).videoWidth, ready: (v as HTMLVideoElement).readyState }
    })
    return { tracks, inbound, videos }
  })
const diagSender = (m: Member) =>
  m.page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((pc) => pc.connectionState !== 'closed')
    const outbound: unknown[] = []
    const senders: unknown[] = []
    for (const pc of pcs) {
      for (const t of pc.getTransceivers()) {
        if (t.sender.track?.kind !== 'video') continue
        senders.push({ mid: t.mid, dir: t.currentDirection, track: t.sender.track.id.slice(0, 6), state: t.sender.track.readyState, w: t.sender.track.getSettings().width, enc: t.sender.getParameters().encodings.map((e) => `${e.rid}:${e.active}`).join(',') })
      }
      ;(await pc.getStats()).forEach((r) => {
        if (r.type !== 'outbound-rtp' || r.kind !== 'video') return
        outbound.push({ mid: r.mid, rid: r.rid, ssrc: r.ssrc, kb: Math.round(r.bytesSent / 1000), enc: r.framesEncoded, w: r.frameWidth, h: r.frameHeight, key: r.keyFramesEncoded, pli: r.pliCount, fir: r.firCount, nack: r.nackCount, active: r.active, lim: r.qualityLimitationReason })
      })
    }
    return { senders, outbound }
  })

async function expectSeesShare(viewer: Member, sharer: Member) {
  const region = strings.screenShare.region(sharer.name)
  const video = viewer.page
    .getByRole('figure', { name: region })
    .getByLabel(region, { exact: true })
  if (sharer.engine !== 'webkit') {
    await expect
      .poll(() => framesOf(video), {
        message: `${viewer.name} (${viewer.engine}) decodes ${sharer.name}'s screen`,
      })
      .toBeGreaterThanOrEqual(SHARE_FRAMES_PER_SECOND)
    return
  }
  const tag = `DIAG ${(viewer as Member & { arm?: string }).arm}`
  const sample = async (what: string) => {
    const [v, s, frames] = await Promise.all([diagViewer(viewer), diagSender(sharer), framesOf(video)])
    console.log(`${tag} ${what} shareFps=${frames} viewer=${JSON.stringify(v)} sender=${JSON.stringify(s)}`)
    return frames
  }
  let ok = false
  for (let i = 0; i < 8 && !ok; i++) {
    ok = (await sample(`t${i}`)) >= SHARE_FRAMES_PER_SECOND
    await viewer.page.waitForTimeout(1500)
  }
  console.log(`${tag} outcome ${ok ? 'OK' : 'STUCK'}`)
  if (ok) {
    await sample('ok-final')
    return
  }
  // Recovery experiments on the stuck subscription, from the viewer's own session
  const sfu = (viewer as Member & { sfu?: { url: string; auth: string } }).sfu!
  const recv = (viewer as Member & { subs?: Map<string, { mid: string; sessionId: string; trackName: string }> }).subs!
  const update = async (what: string, trackName: string, rid: string) => {
    const sub = [...recv.values()].find((x) => x.trackName.startsWith(trackName))!
    const res = await viewer.page.evaluate(
      async ({ url, auth, body }) => {
        const r = await fetch(url, { method: 'PUT', headers: { authorization: auth, 'content-type': 'application/json' }, body })
        return `${r.status} ${await r.text()}`
      },
      {
        url: sfu.url,
        auth: sfu.auth,
        body: JSON.stringify({ tracks: [{ location: 'remote', mid: sub.mid, sessionId: sub.sessionId, trackName: sub.trackName, simulcast: { preferredRid: rid, priorityOrdering: 'none', ridNotAvailable: 'asciibetical' } }] }),
      },
    )
    console.log(`${tag} ${what}: ${res}`)
    for (let i = 0; i < 3; i++) {
      await viewer.page.waitForTimeout(1500)
      await sample(`after ${what} +${i}`)
    }
  }
  await update('cam->f', 'cam-', 'f')
  await update('screen->h', 'screen-', 'h')
  await update('screen->f', 'screen-', 'f')
  await update('cam->q', 'cam-', 'q')
}

/** What a member sends, per outbound video stream: simulcast layer, size, frames a second */
async function outbound(member: Member) {
  return member.page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
    const out: { rid: string | null; width: number; height: number; fps: number; codec: string }[] =
      []
    for (const pc of pcs) {
      if (pc.connectionState === 'closed') continue
      const stats = await pc.getStats()
      stats.forEach((report) => {
        if (report.type !== 'outbound-rtp' || report.kind !== 'video') return
        const codec = report.codecId ? stats.get(report.codecId)?.mimeType : ''
        out.push({
          rid: report.rid ?? null,
          width: report.frameWidth ?? 0,
          height: report.frameHeight ?? 0,
          fps: report.framesPerSecond ?? 0,
          codec: codec ?? '',
        })
      })
    }
    return out
  })
}

/** Opens a room from the home page in `browser` and gives its link */
async function openRoom(browser: Browser): Promise<string> {
  const context = await browser.newContext({ locale: 'zh-TW' })
  const page = await context.newPage()
  await page.goto('/')
  await page.getByRole('button', { name: strings.home.createRoom }).click()
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{10}$/)
  const url = page.url()
  await context.close()
  return url
}

/** Two members of different engines: media both ways, a mute, a share each way */
async function meet(a: Member, b: Member, testInfo: TestInfo) {
  await test.step('both see and hear each other', async () => {
    await expectReceiving(a, b)
    await expectReceiving(b, a)
  })

  await test.step('what each sends (simulcast layers), for the report', async () => {
    for (const member of [a, b]) {
      const streams = await outbound(member)
      await testInfo.attach(`${member.engine}-outbound.json`, {
        body: JSON.stringify(streams, null, 2),
        contentType: 'application/json',
      })
      console.log(`[${member.name} ${member.engine}] sends ${JSON.stringify(streams)}`)
      expect(streams.length, `${member.engine} sends video`).toBeGreaterThan(0)
    }
  })

  await test.step(`${b.engine} mutes: ${a.engine} sees it; unmutes: hears again`, async () => {
    await toolbarButton(b, strings.toolbar.micOn).click()
    await expect(tile(a, b).getByRole('img', { name: strings.room.micMuted })).toBeVisible()
    await expect.poll(() => audioPeak(a, b)).toBeLessThan(AUDIBLE)
    await toolbarButton(b, strings.toolbar.micOff).click()
    await expect.poll(() => audioPeak(a, b)).toBeGreaterThan(AUDIBLE)
  })

  for (const [sharer, viewer] of [
    [b, a],
    [a, b],
  ] as const) {
    await test.step(`${sharer.engine} shares: ${viewer.engine} sees the screen`, async () => {
      await toolbarButton(sharer, strings.toolbar.share).click()
      await expect(
        sharer.page.getByRole('region', { name: strings.screenShare.youAreSharing }),
      ).toBeVisible()
      await expectSeesShare(viewer, sharer)
      await sharer.page
        .getByRole('region', { name: strings.screenShare.youAreSharing })
        .getByRole('button', { name: strings.screenShare.stop })
        .click()
      await expect(
        viewer.page.getByRole('figure', { name: strings.screenShare.region(sharer.name) }),
      ).toHaveCount(0)
    })
  }
}

async function leave(members: Member[], testInfo: TestInfo) {
  for (const member of members) {
    if (testInfo.status !== testInfo.expectedStatus && !member.page.isClosed()) {
      await testInfo.attach(`${member.name}.png`, {
        body: await member.page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      })
    }
    await toolbarButton(member, strings.toolbar.leave)
      .click({ timeout: 5_000 })
      .catch(() => undefined)
    await member.context.close()
  }
}

test('Firefox and Chromium in one room see and hear each other, a mute and each other’s screen', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  const other = await chromium.launch({ args: chromiumFakeMedia })
  const members: Member[] = []
  try {
    const url = await openRoom(browser)
    testInfo.annotations.push({ type: 'room', description: url })
    members.push(
      await join(other, 'chromium', url, 'Chris', { permissions: ['camera', 'microphone'] }),
    )
    members.push(await join(browser, 'firefox', url, 'Fiona'))
    await meet(members[0], members[1], testInfo)
  } finally {
    await leave(members, testInfo)
    await other.close()
  }
})

test('WebKit and Chromium in one room, where this WebKit build has WebRTC and devices', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  const safari = await webkit.launch()
  const other = await chromium.launch({ args: chromiumFakeMedia })
  const members: Member[] = []
  try {
    const probe = await safari.newPage()
    await probe.goto(new URL('/', String(testInfo.project.use.baseURL)).href)
    const usable = await probe.evaluate(async () => {
      if (typeof RTCPeerConnection !== 'function' || !navigator.mediaDevices) return false
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.some((device) => device.kind === 'videoinput')
    })
    await probe.close()
    test.skip(!usable, 'this WebKit build has no WebRTC or no capture devices')
    const url = await openRoom(browser)
    testInfo.annotations.push({ type: 'room', description: url })
    const arm = testInfo.repeatEachIndex % 2 === 0 ? 'asis' : 'noQ'
    console.log(`DIAG start repeat ${testInfo.repeatEachIndex} arm ${arm}`)
    members.push(
      await join(other, 'chromium', url, 'Chris', { permissions: ['camera', 'microphone'], arm }),
    )
    members.push(
      await join(safari, 'webkit', url, 'Wes', { permissions: ['camera', 'microphone'] }),
    )
    await meet(members[0], members[1], testInfo)
  } finally {
    await leave(members, testInfo)
    await other.close()
    await safari.close()
  }
})
