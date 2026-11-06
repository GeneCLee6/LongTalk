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
  await context.addInitScript(diagScript) // TEMP-DIAG
  const page = await context.newPage()
  const diagLog = diagEvents(page) // TEMP-DIAG
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
  // TEMP-DIAG
  await page
    .getByRole('button', { name: strings.prejoin.join, exact: true })
    .click()
    .catch(async (error: unknown) => {
      await diagDump(page, `STUCK real ${name}`, diagLog)
      await test.info().attach(`stuck-${name}.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      })
      throw error
    })
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
      // Pressed with the camera on, as people do. Playwright's Linux WebKit cannot run two video
      // encoders side by side (14 of 31 runs lost the share, 0 of 7 with the camera off; ADR-001
      // 「WebKit 同時送鏡頭與分享」), so the app turns the camera off first there
      // (`shareStopsCamera`) and brings it back after; Chromium and Firefox send both.
      const guarded = sharer.engine === 'webkit'
      await toolbarButton(sharer, strings.toolbar.share).click()
      await expect(
        sharer.page.getByRole('region', { name: strings.screenShare.youAreSharing }),
      ).toBeVisible()
      if (guarded) {
        await expect(sharer.page.getByText(strings.screenShare.cameraOffForShare)).toBeVisible()
        await expect(toolbarButton(sharer, strings.toolbar.camOff)).toBeDisabled()
        await expect(tile(viewer, sharer)).toContainText(strings.room.camOff)
      } else {
        await expect(toolbarButton(sharer, strings.toolbar.camOn)).toBeEnabled()
      }
      await expectSeesShare(viewer, sharer)
      await sharer.page
        .getByRole('region', { name: strings.screenShare.youAreSharing })
        .getByRole('button', { name: strings.screenShare.stop })
        .click()
      await expect(
        viewer.page.getByRole('figure', { name: strings.screenShare.region(sharer.name) }),
      ).toHaveCount(0)
      if (guarded) {
        // Back by itself, and viewers get it again
        await expect(toolbarButton(sharer, strings.toolbar.camOn)).toBeEnabled()
        await expectReceiving(viewer, sharer)
      }
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

// TEMP-DIAG-START
function diagScript() {
  const log: string[] = []
  ;(window as unknown as { __diag: string[] }).__diag = log
  const add = (text: string) => log.push(`${Math.round(performance.now())} ${text}`)
  const loads = Number(sessionStorage.getItem('__loads') ?? 0) + 1
  sessionStorage.setItem('__loads', String(loads))
  add(`load #${loads} vendor=${navigator.vendor} online=${navigator.onLine}`)
  const describe = (t: EventTarget | null) => {
    const e = t as HTMLElement | null
    if (!e || !e.tagName) return String(t)
    return `${e.tagName}[${e.getAttribute?.('type') ?? ''}]#conn=${e.isConnected}`
  }
  for (const type of ['beforeinput', 'input', 'change', 'focusin', 'focusout', 'compositionstart', 'compositionend', 'keydown']) {
    document.addEventListener(
      type,
      (event) => {
        const target = event.target as HTMLInputElement
        add(`${type} ${describe(event.target)} value=${JSON.stringify(target.value ?? null)} data=${JSON.stringify((event as InputEvent).data ?? null)} composing=${(event as InputEvent).isComposing ?? ''}`)
      },
      true,
    )
  }
  for (const type of ['pagehide', 'beforeunload', 'error', 'unhandledrejection', 'online', 'offline', 'focus', 'blur', 'pageshow']) {
    window.addEventListener(type, (event) => add(`window ${type} ${(event as ErrorEvent).message ?? ''} ${String((event as PromiseRejectionEvent).reason ?? '')}`), true)
  }
  document.addEventListener('visibilitychange', () => add(`visibility ${document.visibilityState}`))
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        const e = node as HTMLElement
        if (e.nodeType !== 1) continue
        if (e.tagName === 'INPUT' || e.querySelector?.('input')) add(`REMOVED ${e.tagName} with input`)
      }
      for (const node of record.addedNodes) {
        const e = node as HTMLElement
        if (e.nodeType !== 1) continue
        if (e.tagName === 'INPUT' || e.querySelector?.('input')) {
          const input = (e.tagName === 'INPUT' ? e : e.querySelector('input')) as HTMLInputElement
          add(`ADDED ${e.tagName} with input value=${JSON.stringify(input.value)}`)
        }
      }
    }
  }).observe(document, { childList: true, subtree: true })
}

async function diagDump(page: Page, label: string, extra: string[]) {
  const state = await page
    .evaluate(() => {
      const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
      const buttons = [...document.querySelectorAll('button[type=submit]')] as HTMLButtonElement[]
      const props = (e: Element) => {
        const key = Object.keys(e).find((k) => k.startsWith('__reactProps'))
        const p = key ? (e as unknown as Record<string, Record<string, unknown>>)[key] : null
        return p ? { value: p.value, disabled: p.disabled, required: p.required } : null
      }
      const tracker = (e: Element) =>
        (e as unknown as { _valueTracker?: { getValue(): string } })._valueTracker?.getValue()
      const active = document.activeElement as HTMLElement | null
      return {
        url: location.href,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        active: active ? active.tagName : null,
        activeIsInput: active === inputs[0],
        inputs: inputs.map((e) => ({
          type: e.type,
          value: e.value,
          react: props(e),
          tracker: tracker(e),
        })),
        buttons: buttons.map((e) => ({ text: e.textContent, disabled: e.disabled, react: props(e) })),
        name: localStorage.getItem('longtalk.name'),
        loads: sessionStorage.getItem('__loads'),
        body: document.body.innerText.slice(0, 500),
        controller: navigator.serviceWorker?.controller?.state ?? null,
        log: (window as unknown as { __diag: string[] }).__diag,
      }
    })
    .catch((error: unknown) => ({ evaluateFailed: String(error) }))
  console.log(`[DIAG ${label}] ${JSON.stringify(state)} events=${JSON.stringify(extra)}`)
}

function diagEvents(page: Page) {
  const events: string[] = []
  const start = Date.now()
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) events.push(`+${Date.now() - start} nav ${frame.url()}`)
  })
  page.on('pageerror', (error) => events.push(`+${Date.now() - start} pageerror ${error.message}`))
  page.on('console', (m) => events.push(`+${Date.now() - start} ${m.type()} ${m.text().slice(0, 200)}`))
  page.on('crash', () => events.push(`+${Date.now() - start} crash`))
  return events
}

test('TEMP join probe under load', async ({ browser }, testInfo) => {
  test.setTimeout(480_000)
  const { spawn } = await import('node:child_process')
  const url = await openRoom(browser)
  const other = await chromium.launch({ args: chromiumFakeMedia })
  const started = Date.now()
  const counts = { 0: [0, 0], 8: [0, 0], 16: [0, 0] } as Record<number, number[]>
  let tried = 0
  try {
    while (Date.now() - started < 400_000) {
      const hogs = [0, 8, 16][tried % 3]
      tried += 1
      const children = Array.from({ length: hogs }, () =>
        spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }),
      )
      const safari = await webkit.launch()
      let chris: Member | null = null
      try {
        const probe = await safari.newPage()
        await probe.goto(new URL('/', String(testInfo.project.use.baseURL)).href)
        await probe.close()
        chris = await join(other, 'chromium', url, 'Chris', {
          permissions: ['camera', 'microphone'],
        })
        const context = await safari.newContext({
          locale: 'zh-TW',
          permissions: ['camera', 'microphone'],
        })
        await context.addInitScript(stubScreen)
        await context.addInitScript(keepPeerConnections)
        await context.addInitScript(diagScript)
        const page = await context.newPage()
        const events = diagEvents(page)
        await page.goto(url)
        await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill('Wes')
        const button = page.getByRole('button', { name: strings.prejoin.join, exact: true })
        const ok = await expect(button)
          .toBeEnabled({ timeout: 8_000 })
          .then(() => true)
          .catch(() => false)
        counts[hogs][0] += 1
        if (!ok) {
          counts[hogs][1] += 1
          await diagDump(page, `STUCK ${tried} hogs=${hogs}`, events)
        }
      } catch (error) {
        console.log(`[DIAG other failure ${tried} hogs=${hogs}] ${String(error).slice(0, 300)}`)
      } finally {
        for (const child of children) child.kill('SIGKILL')
        await chris?.context.close().catch(() => undefined)
        await safari.close().catch(() => undefined)
      }
    }
  } finally {
    console.log(`[DIAG summary] tried=${tried} [joins, stuck] by hogs ${JSON.stringify(counts)}`)
    await other.close()
  }
})
// TEMP-DIAG-END

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
