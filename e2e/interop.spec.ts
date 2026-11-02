import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { strings } from '../src/strings.ts'

// e2-t10 (AC-2.2): three browsers with Chrome's fake camera and microphone (a moving picture and
// a beep) open one room through the home page, join through the pre-join screen a few seconds
// apart, and must each see and hear the other two through the real Realtime SFU (three, because
// two never showed the lost-video races fixed after C1); muting and turning the camera off must
// show on the other side, and turning them back on must bring the media back. Runs against a
// deployed Worker (playwright.config.ts): in CI the pull request's preview (preview.yml, job
// `e2e`).
//
// Every member is a context of the one Chromium (its own storage: a different member). Separate
// browser processes were tried and were worse: Chrome's fake camera was then often missing
// altogether (getUserMedia: NotFoundError), which the logs below make easy to tell apart.

const VIDEO_FRAMES_PER_SECOND = 5
/** Joins this far apart: the next member arrives while the last one is still negotiating */
const JOIN_GAP_MS = 3_000
/** Chrome's fake microphone beeps at full scale; silence is exactly 0 */
const AUDIBLE = 0.05

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

/** The loudest sample of `other`'s microphone that `viewer` plays, over 1.5 seconds */
async function audioPeak(viewer: Member, other: Member): Promise<number> {
  // Sound plays apart from the tiles (MemberAudio, e4-t07), one element per member
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
    interop.setTimeout(180_000)
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
  },
)
