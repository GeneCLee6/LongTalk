import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
// The browsers run in zh-TW (playwright.config.ts): the Chinese dictionary, whatever Node's locale
import { zhTW as strings } from '../src/i18n/zh-TW.ts'

// O2 (e11-t12): the chaos drills against a deployed Worker with the real Realtime SFU (in CI the
// pull request's preview, preview.yml job `e2e`; DEPLOY.md §14). Each drill breaks one thing in
// the middle of a meeting and checks the meeting heals by itself, without anyone reloading:
//
// 1. TURN unreachable: one member's /api/turn never answers. Media must still connect (STUN only,
//    after RoomMedia's ICE_CONFIG_TIMEOUT_MS) and both see and hear each other.
// 2. SFU unreachable, then back: one member joins while every /api/sfu call fails. She is in the
//    room (the others see her tile, her chat arrives) and is told the media is coming back; once
//    the SFU answers again her camera reaches the others with no click.
// 3. The room's Durable Object is killed (POST /api/chaos/rooms/<id>/kill, worker/chaos.ts; only
//    where CHAOS_DRILLS is "1", so skipped against production): every socket closes; everyone
//    reconnects with their token, keeps their seat and the chat, and the media never stopped (it
//    does not go through the object).
//
// What this cannot do from a browser: cut the SFU's media path itself (UDP) or TURN's relay ports;
// those are in the owner's steps (DEPLOY.md §14) and in tests/app/RoomMedia.test.ts.

const VIDEO_FRAMES_PER_SECOND = 5
/** Chrome's fake microphone beeps at full scale; silence is exactly 0 */
const AUDIBLE = 0.05

interface Member {
  name: string
  context: BrowserContext
  page: Page
}

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

/** A new browser that joins through the pre-join screen; `prepare` runs before it opens the room */
async function join(
  browser: Browser,
  roomUrl: string,
  name: string,
  prepare?: (context: BrowserContext) => Promise<unknown>,
): Promise<Member> {
  const context = await browser.newContext({
    locale: 'zh-TW',
    permissions: ['camera', 'microphone'],
  })
  await prepare?.(context)
  const page = await context.newPage()
  const started = Date.now()
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const at = ((Date.now() - started) / 1000).toFixed(1)
      console.log(`[${name} ${at}s] ${message.text().slice(0, 300)}`)
    }
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

/** The loudest sample of `other`'s microphone `viewer` plays (MemberAudio, one element each) */
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

async function expectReceiving(viewer: Member, other: Member, timeout = 30_000) {
  await expect(remoteVideo(viewer, other), `${viewer.name} sees ${other.name}`).toBeVisible({
    timeout,
  })
  await expect
    .poll(() => framesPerSecond(viewer, other), {
      message: `${viewer.name} decodes frames of ${other.name}'s camera`,
      timeout,
    })
    .toBeGreaterThanOrEqual(VIDEO_FRAMES_PER_SECOND)
  await expect
    .poll(() => audioPeak(viewer, other), {
      message: `${viewer.name} hears ${other.name}'s microphone`,
      timeout,
    })
    .toBeGreaterThan(AUDIBLE)
}

async function say(member: Member, text: string) {
  const box = member.page.getByRole('textbox', { name: strings.chat.inputLabel })
  if (!(await box.isVisible())) await toolbarButton(member, strings.toolbar.chat).click()
  await box.fill(text)
  await box.press('Enter')
  await expect(box).toHaveValue('')
}

async function expectChat(member: Member, text: string, timeout = 30_000) {
  const box = member.page.getByRole('textbox', { name: strings.chat.inputLabel })
  if (!(await box.isVisible())) await toolbarButton(member, strings.toolbar.chat).click()
  await expect(member.page.getByRole('log', { name: strings.chat.messages })).toContainText(text, {
    timeout,
  })
}

/** A fresh room per drill; afterwards everyone leaves (closing their SFU session at once) */
const drill = test.extend<{
  room: {
    url: string
    join: (name: string, prepare?: (c: BrowserContext) => Promise<unknown>) => Promise<Member>
  }
}>({
  room: async ({ browser }, provide, testInfo) => {
    const url = await openRoom(browser)
    testInfo.annotations.push({ type: 'room', description: url })
    const members: Member[] = []
    await provide({
      url,
      join: async (name, prepare) => {
        const member = await join(browser, url, name, prepare)
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

drill('TURN unreachable: media still connects, through STUN only (e11-t12)', async ({ room }) => {
  drill.setTimeout(180_000)
  const alice = await room.join('Alice')
  // Bob's TURN endpoint never answers: not refused, hanging, the harder case
  const bob = await room.join('Bob', (context) =>
    context.route('**/api/turn/**', () => new Promise<void>(() => {})),
  )
  const started = Date.now()
  await expectReceiving(alice, bob, 45_000)
  await expectReceiving(bob, alice, 45_000)
  console.log(`[drill] TURN hanging: Bob's media both ways after ${(Date.now() - started) / 1000}s`)
})

drill(
  'SFU unreachable, then back: the member is in the room meanwhile and her media comes back by itself (e11-t12)',
  async ({ room }) => {
    drill.setTimeout(180_000)
    const alice = await room.join('Alice')
    let sfuDown = true
    const carol = await room.join('Carol', (context) =>
      context.route('**/api/sfu/**', (route) =>
        sfuDown ? route.abort('connectionrefused') : route.continue(),
      ),
    )
    // She is in the meeting: the others see her, the chat works
    await expect(tile(alice, carol)).toBeVisible()
    await say(carol, '我的媒體連不上，但聊天可以')
    await expectChat(alice, '我的媒體連不上，但聊天可以')
    await expect(
      carol.page.getByText(strings.room.mediaReconnecting).or(
        carol.page.getByText(strings.room.mediaConnecting),
      ),
    ).toBeVisible()
    expect(await remoteVideo(alice, carol).count()).toBe(0)

    // 20 seconds of outage, well inside RECONNECT_GRACE_MS: no click needed afterwards
    await new Promise((resolve) => setTimeout(resolve, 20_000))
    sfuDown = false
    const back = Date.now()
    await expectReceiving(alice, carol, 60_000)
    await expectReceiving(carol, alice, 30_000)
    console.log(`[drill] SFU back: Carol's media both ways after ${(Date.now() - back) / 1000}s`)
  },
)

drill(
  'the room’s Durable Object is killed: everyone reconnects to the same seat, chat kept, media never stopped (e11-t12)',
  async ({ room, request }) => {
    drill.setTimeout(180_000)
    const roomId = new URL(room.url).pathname.split('/').at(-1)!
    const alice = await room.join('Alice')
    const bob = await room.join('Bob')
    await expectReceiving(alice, bob)
    await expectReceiving(bob, alice)
    await say(alice, '殺掉之前的訊息')
    await expectChat(bob, '殺掉之前的訊息')

    const killed = Date.now()
    const res = await request.post(`/api/chaos/rooms/${roomId}/kill`)
    drill.skip(res.status() === 404, 'this deployment has no chaos drills (CHAOS_DRILLS)')
    expect(res.status()).toBe(200)

    // Both come back by themselves: a message after the kill goes through the new object
    await say(bob, '殺掉之後的訊息')
    await expectChat(alice, '殺掉之後的訊息')
    console.log(`[drill] DO killed: chat works again after ${(Date.now() - killed) / 1000}s`)
    for (const member of [alice, bob]) {
      await expect(member.page.getByText(strings.room.reconnectingSelf)).toBeHidden({
        timeout: 30_000,
      })
    }
    // The history from before is still there, and nobody's tile says they are away
    await expectChat(bob, '殺掉之前的訊息')
    await expect(tile(alice, bob)).not.toContainText(strings.room.reconnecting)
    // The media went on through the SFU the whole time
    await expectReceiving(alice, bob)
    await expectReceiving(bob, alice)
  },
)
