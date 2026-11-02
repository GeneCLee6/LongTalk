import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { strings } from '../src/strings.ts'

// e2-t10 (AC-2.2): three browsers with Chrome's fake camera and microphone (a moving picture and
// a beep) open one room through the home page, join through the pre-join screen a few seconds
// apart, and must each see and hear the other two through the real Realtime SFU (three, because
// two never showed the lost-video races fixed after C1); muting and turning the camera off must
// show on the other side, and turning them back on must bring the media back. Then screen sharing
// (D1): one member shares, the others see the share in the main area and hear its sound (D2);
// the sharer turns the sound off from the bar and the others hear silence; another takes over
// after the question; the share stops from the bar and everyone is back in the gallery. Runs
// against a
// deployed Worker (playwright.config.ts): in CI the pull request's preview (preview.yml, job
// `e2e`).
//
// The screen is a stand-in: headless Chromium has no screen to capture and no picker to click, so
// getDisplayMedia is replaced (addInitScript) by a canvas captureStream of a moving picture, and,
// when the room asks for audio (Chromium can share a tab's sound, e3-t04), an oscillator's tone
// as the tab's sound. What is tested is everything after the picker: the room's share state,
// publishing (VP8, like the camera; the sound as a track of its own), the layout, the sound
// switch and the stop paths. The real picker, real tab and system audio and echo are on the
// owner's two-device checklist (DEPLOY.md §5).
//
// Every member is a context of the one Chromium (its own storage: a different member). Separate
// browser processes were tried and were worse: Chrome's fake camera was then often missing
// altogether (getUserMedia: NotFoundError), which the logs below make easy to tell apart.

const VIDEO_FRAMES_PER_SECOND = 5
/** Joins this far apart: the next member arrives while the last one is still negotiating */
const JOIN_GAP_MS = 3_000
/** Chrome's fake microphone beeps at full scale; silence is exactly 0 */
const AUDIBLE = 0.05
/** The stand-in screen draws 15 frames a second; a static screen would send far fewer */
const SHARE_FRAMES_PER_SECOND = 3

interface Member {
  name: string
  context: BrowserContext
  page: Page
}

/** Opens a new room from the home page and gives its link */
async function openRoom(browser: Browser): Promise<string> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/')
  await page.getByRole('button', { name: strings.home.createRoom }).click()
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{10}$/)
  const url = page.url()
  await context.close()
  return url
}

/** A new browser (its own storage: a different member) that joins through the pre-join screen */
async function join(browser: Browser, roomUrl: string, name: string): Promise<Member> {
  const context = await browser.newContext({
    locale: 'zh-TW',
    permissions: ['camera', 'microphone'],
  })
  // The screen to share: a moving picture on a canvas instead of the browser's picker (above)
  await context.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async (options?: DisplayMediaStreamOptions) => {
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
        context.fillStyle = '#0f172a'
        context.font = '48px sans-serif'
        context.fillText(`LongTalk share ${frame}`, 80, 120)
      }
      draw()
      const timer = setInterval(draw, 1000 / 15)
      const stream = canvas.captureStream(15)
      // The tab's sound, when asked for: a steady tone (Chrome's picker shares it by default)
      const sound = options?.audio ? new AudioContext() : null
      if (sound) {
        const tone = sound.createOscillator()
        const out = sound.createMediaStreamDestination()
        tone.connect(out)
        tone.start()
        void sound.resume()
        stream.addTrack(out.stream.getAudioTracks()[0])
      }
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        clearInterval(timer)
        void sound?.close()
      })
      return stream
    }
  })
  // The PeerConnection's states and failed SDP steps, for reading a failure in the CI log
  await context.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = (constraints) =>
      getUserMedia(constraints).catch((error: unknown) => {
        console.info(`[pc] getUserMedia(${JSON.stringify(constraints)}): ${String(error)}`)
        throw error
      })
    const Native = window.RTCPeerConnection
    let count = 0
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config)
        const id = ++count
        const say = (text: string) => console.info(`[pc${id}] ${text}`)
        this.addEventListener('connectionstatechange', () => say(this.connectionState))
        for (const method of ['setLocalDescription', 'setRemoteDescription'] as const) {
          const original = this[method].bind(this) as (
            d?: RTCSessionDescriptionInit,
          ) => Promise<void>
          this[method] = ((description?: RTCSessionDescriptionInit) =>
            original(description).catch((error: unknown) => {
              say(`${method}(${description?.type}) in ${this.signalingState}: ${String(error)}`)
              throw error
            })) as never
        }
      }
    }
  })
  const page = await context.newPage()
  // Seconds since this member opened the room, on every line it logs
  const started = Date.now()
  const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'error' || text.startsWith('[pc')) {
      console.log(`[${name} ${at()}] ${text.slice(0, 300)}`)
    }
  })
  // Every SFU call and what came back, and what the member tells the room it publishes, for
  // reading a failure in the CI log
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.startsWith('{"t":"tracks"')) return
      const names = [...payload.matchAll(/"trackName":"([^"]+)"/g)].map((m) => m[1])
      console.log(`[${name} ${at()}] tracks → room: ${names.join(',')}`)
    }),
  )
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname
    if (!path.startsWith('/api/sfu/')) return
    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      errorCode?: string
      requiresImmediateRenegotiation?: boolean
      tracks?: { trackName?: string; mid?: string; errorCode?: string }[]
    }
    const request = response.request().postData() ?? ''
    const what = /"location":"(local|remote)"/.exec(request)?.[1] === 'local' ? 'push' : 'pull'
    const tracks = (body.tracks ?? [])
      .map((t) => `${t.trackName ?? ''}@${t.mid ?? ''}${t.errorCode ? `!${t.errorCode}` : ''}`)
      .join(',')
    const call = path.replace(/^\/api\/sfu\/[^/]+\/sessions\/?/, '').replace(/^[0-9a-f]{64}/, 'S')
    const errors = [body.error, body.errorCode].filter(Boolean).join(' ')
    console.log(
      `[${name} ${at()}] ${response.request().method()} ` +
        `${call || 'sessions'}${call.endsWith('/tracks') ? ` ${what}` : ''} → ${response.status()}` +
        `${errors ? ` ${errors}` : ''}${body.requiresImmediateRenegotiation ? ' rir' : ''} ${tracks}`,
    )
  })
  await page.goto(roomUrl)
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill(name)
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
  return { name, context, page }
}

const tile = (viewer: Member, other: Member) =>
  viewer.page.getByRole('figure', { name: other.name, exact: true })

const remoteVideo = (viewer: Member, other: Member) =>
  tile(viewer, other).getByLabel(strings.room.tileVideo(other.name), { exact: true })

const toolbarButton = (member: Member, name: string) =>
  member.page
    .getByRole('toolbar', { name: strings.devices.controls })
    .getByRole('button', { name, exact: true })

/** Frames `viewer` decoded of `other`'s camera in one second (0 when there is no video) */
async function framesPerSecond(viewer: Member, other: Member): Promise<number> {
  const video = remoteVideo(viewer, other)
  if ((await video.count()) === 0) return 0
  return video.evaluate(async (element: HTMLVideoElement) => {
    if (element.videoWidth === 0) return 0
    const before = element.getVideoPlaybackQuality().totalVideoFrames
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return element.getVideoPlaybackQuality().totalVideoFrames - before
  })
}

/** The stage: data-mode is `share` while someone else's share is in the main area */
const stage = (member: Member) => member.page.getByRole('region', { name: strings.room.grid })

/** `sharer`'s screen as `viewer` sees it in the main area */
const shareVideo = (viewer: Member, sharer: Member) =>
  viewer.page
    .getByRole('figure', { name: strings.screenShare.region(sharer.name) })
    .getByLabel(strings.screenShare.region(sharer.name), { exact: true })

/** Frames `viewer` decoded of `sharer`'s screen in one second (0 when there is none) */
async function shareFramesPerSecond(viewer: Member, sharer: Member): Promise<number> {
  const video = shareVideo(viewer, sharer)
  if ((await video.count()) === 0) return 0
  return video.evaluate(async (element: HTMLVideoElement) => {
    if (element.videoWidth === 0) return 0
    const before = element.getVideoPlaybackQuality().totalVideoFrames
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return element.getVideoPlaybackQuality().totalVideoFrames - before
  })
}

async function expectSeesShare(viewer: Member, sharer: Member) {
  await expect(stage(viewer), `${viewer.name} has the share layout`).toHaveAttribute(
    'data-mode',
    'share',
  )
  await expect(
    viewer.page.getByText(strings.screenShare.label(sharer.name), { exact: true }),
  ).toBeVisible()
  await expect
    .poll(() => shareFramesPerSecond(viewer, sharer), {
      message: `${viewer.name} decodes frames of ${sharer.name}'s screen`,
    })
    .toBeGreaterThanOrEqual(SHARE_FRAMES_PER_SECOND)
}

/** The loudest sample of `other`'s microphone that `viewer` plays, over 1.5 seconds */
function audioPeak(viewer: Member, other: Member): Promise<number> {
  // Sound plays apart from the tiles (MemberAudio, e4-t07), one element per member
  return peakOf(viewer.page.locator(`audio[data-member="${other.name}"]`))
}

/** The loudest sample of the sound of `sharer`'s share that `viewer` plays (D2, e3-t04) */
function sharePeak(viewer: Member, sharer: Member): Promise<number> {
  return peakOf(viewer.page.locator(`audio[data-share-audio="${sharer.name}"]`))
}

async function peakOf(audio: ReturnType<Page['locator']>): Promise<number> {
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
  await expect(
    remoteVideo(viewer, other),
    `${viewer.name} sees ${other.name}'s video`,
  ).toBeVisible()
  await expect
    .poll(() => framesPerSecond(viewer, other), {
      message: `${viewer.name} decodes frames of ${other.name}'s camera`,
    })
    .toBeGreaterThanOrEqual(VIDEO_FRAMES_PER_SECOND)
  await expect
    .poll(() => audioPeak(viewer, other), {
      message: `${viewer.name} hears ${other.name}'s microphone`,
    })
    .toBeGreaterThan(AUDIBLE)
}

/**
 * A fresh room for the test, and the members who join it; afterwards every member leaves (which
 * closes their SFU session at once) and, after a failure, leaves a screenshot in the report
 */
const interop = test.extend<{ room: { url: string; join: (name: string) => Promise<Member> } }>({
  room: async ({ browser }, provide, testInfo) => {
    const url = await openRoom(browser)
    testInfo.annotations.push({ type: 'room', description: url })
    const members: Member[] = []
    await provide({
      url,
      join: async (name) => {
        const member = await join(browser, url, name)
        members.push(member)
        return member
      },
    })
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
  },
})

interop(
  'three browsers joining a few seconds apart all see and hear each other, and see mute and camera off (AC-2.2)',
  async ({ room }) => {
    interop.setTimeout(300_000)
    const alice = await room.join('Alice')
    await new Promise((resolve) => setTimeout(resolve, JOIN_GAP_MS))
    const bob = await room.join('Bob')
    await new Promise((resolve) => setTimeout(resolve, JOIN_GAP_MS))
    const carol = await room.join('Carol')
    const members = [alice, bob, carol]

    await interop.step('the top bar names the room after its first member (e1-t05)', async () => {
      for (const member of members) {
        await expect(
          member.page.getByRole('heading', { name: strings.room.defaultName('Alice') }),
        ).toBeVisible()
      }
    })

    await interop.step('every way: video frames and audio', async () => {
      for (const viewer of members) {
        for (const other of members) {
          if (viewer !== other) await expectReceiving(viewer, other)
        }
      }
    })

    await interop.step('Alice mutes: Bob sees the muted microphone and hears silence', async () => {
      await toolbarButton(alice, strings.toolbar.micOn).click()
      await expect(tile(bob, alice).getByRole('img', { name: strings.room.micMuted })).toBeVisible()
      await expect.poll(() => audioPeak(bob, alice)).toBeLessThan(AUDIBLE)
    })

    await interop.step('Alice turns the camera off: Bob sees her initial instead', async () => {
      await toolbarButton(alice, strings.toolbar.camOn).click()
      await expect(remoteVideo(bob, alice)).toHaveCount(0)
      await expect(tile(bob, alice)).toContainText(strings.room.camOff)
    })

    await interop.step('Alice turns both back on: Bob sees and hears her again', async () => {
      await toolbarButton(alice, strings.toolbar.micOff).click()
      await toolbarButton(alice, strings.toolbar.camOff).click()
      await expect(tile(bob, alice).getByRole('img', { name: strings.room.micMuted })).toHaveCount(
        0,
      )
      await expectReceiving(bob, alice)
    })

    await interop.step('Bob mutes: Alice sees it, and still receives his camera', async () => {
      await toolbarButton(bob, strings.toolbar.micOn).click()
      await expect(tile(alice, bob).getByRole('img', { name: strings.room.micMuted })).toBeVisible()
      await expect
        .poll(() => framesPerSecond(alice, bob))
        .toBeGreaterThanOrEqual(VIDEO_FRAMES_PER_SECOND)
    })

    await interop.step(
      'Bob shares his screen: Alice and Carol see it in the main area (D1)',
      async () => {
        await toolbarButton(bob, strings.toolbar.share).click()
        await expect(
          bob.page.getByRole('region', { name: strings.screenShare.youAreSharing }),
        ).toBeVisible()
        // Bob is not shown his own screen (no endless mirror): he keeps the gallery
        await expect(stage(bob)).toHaveAttribute('data-mode', 'grid')
        await expectSeesShare(alice, bob)
        await expectSeesShare(carol, bob)
        // The share's sound, apart from Bob's microphone (muted above): both hear it
        for (const viewer of [alice, carol]) {
          await expect
            .poll(() => sharePeak(viewer, bob), {
              message: `${viewer.name} hears the sound of ${bob.name}'s share`,
            })
            .toBeGreaterThan(AUDIBLE)
        }
        // Everyone's camera is still in the strip
        await expect
          .poll(() => framesPerSecond(alice, carol))
          .toBeGreaterThanOrEqual(VIDEO_FRAMES_PER_SECOND)
      },
    )

    await interop.step(
      "Bob turns the share's sound off from the bar: silence, the screen goes on (D2)",
      async () => {
        const bar = bob.page.getByRole('region', { name: strings.screenShare.youAreSharing })
        await bar.getByRole('button', { name: strings.screenShare.audioOn }).click()
        await expect(bar.getByRole('button', { name: strings.screenShare.audioOff })).toBeVisible()
        await expect
          .poll(() => sharePeak(alice, bob), { message: "Alice hears the share's sound stop" })
          .toBeLessThan(AUDIBLE)
        await expect
          .poll(() => shareFramesPerSecond(alice, bob))
          .toBeGreaterThanOrEqual(SHARE_FRAMES_PER_SECOND)
        // And back on
        await bar.getByRole('button', { name: strings.screenShare.audioOff }).click()
        await expect
          .poll(() => sharePeak(alice, bob), { message: "Alice hears the share's sound again" })
          .toBeGreaterThan(AUDIBLE)
      },
    )

    await interop.step('Carol takes over after the question: Bob stops sharing', async () => {
      await toolbarButton(carol, strings.toolbar.share).click()
      const dialog = carol.page.getByRole('alertdialog', {
        name: strings.screenShare.takeOverTitle,
      })
      await expect(dialog).toContainText(bob.name)
      await dialog.getByRole('button', { name: strings.screenShare.takeOver }).click()
      await expect(
        carol.page.getByRole('region', { name: strings.screenShare.youAreSharing }),
      ).toBeVisible()
      await expect(
        bob.page.getByRole('region', { name: strings.screenShare.youAreSharing }),
      ).toHaveCount(0)
      await expect(toolbarButton(bob, strings.toolbar.share)).toBeVisible()
      await expectSeesShare(alice, carol)
      await expectSeesShare(bob, carol)
      // Bob's share took its sound with it; Carol's has its own
      await expect(alice.page.locator(`audio[data-share-audio="${bob.name}"]`)).toHaveCount(0)
      await expect
        .poll(() => sharePeak(alice, carol), { message: "Alice hears the sound of Carol's share" })
        .toBeGreaterThan(AUDIBLE)
    })

    await interop.step('Carol stops from the bar: everyone is back in the gallery', async () => {
      await carol.page
        .getByRole('region', { name: strings.screenShare.youAreSharing })
        .getByRole('button', { name: strings.screenShare.stop })
        .click()
      for (const member of members) {
        await expect(stage(member)).toHaveAttribute('data-mode', 'grid')
      }
      await expect(
        alice.page.getByRole('figure', { name: strings.screenShare.region(carol.name) }),
      ).toHaveCount(0)
    })
  },
)
