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
  options: BrowserContextOptions = {},
): Promise<Member> {
  const context = await browser.newContext({ locale: 'zh-TW', ...options })
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
  await page.goto(url)
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill(name)
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
  return { name, engine, context, page }
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

/** The loudest sample `viewer` plays of `other`'s microphone over 1.5 seconds */
async function audioPeak(viewer: Member, other: Member): Promise<number> {
  const audio = viewer.page.locator(`audio[data-member="${other.name}"]`)
  if ((await audio.count()) === 0) return 0
  return audio.evaluate(async (element: HTMLAudioElement) => {
    const stream = element.srcObject
    if (!(stream instanceof MediaStream) || stream.getAudioTracks().length === 0) return 0
    const context = new AudioContext()
    try {
      await context.resume()
      const analyser = context.createAnalyser()
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let peak = 0
      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        analyser.getFloatTimeDomainData(samples)
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
      }
      return peak
    } finally {
      await context.close()
    }
  })
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

async function expectSeesShare(viewer: Member, sharer: Member) {
  const region = strings.screenShare.region(sharer.name)
  const video = viewer.page
    .getByRole('figure', { name: region })
    .getByLabel(region, { exact: true })
  await expect
    .poll(() => framesOf(video), {
      message: `${viewer.name} (${viewer.engine}) decodes ${sharer.name}'s screen`,
    })
    .toBeGreaterThanOrEqual(SHARE_FRAMES_PER_SECOND)
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
    members.push(
      await join(other, 'chromium', url, 'Chris', { permissions: ['camera', 'microphone'] }),
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
