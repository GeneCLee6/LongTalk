import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import {
  capabilityScript,
  docMarks,
  type Capabilities,
  type DocBrowser,
} from './capabilityProbe.ts'
import { joinRoom, newRoom, openPreJoin, strings } from './helpers.ts'
import type { Capability } from '../../src/media/capabilities.ts'

// The cross-browser smoke suite (H6, e2-t16, AC-2.8): the same checks in Chromium, Firefox and
// WebKit (Playwright's build of Safari's engine), against `vite preview` (no Realtime SFU, so no
// media between members; that is the interop test's, e2e/interop.spec.ts). Each browser is asked
// what LongTalk detects there (the app's own capabilities.ts) and the answer is held against
// docs/BROWSER-SUPPORT.md; then home, pre-join (with fake devices, with devices denied, with
// none), two members in a room with chat and the participants panel, and a phone-sized window.
// What each browser reported goes to browser-report/<project>.json (the CI job's summary).

/** Which column of the doc each project's engine stands for */
const COLUMN: Record<string, DocBrowser> = {
  chromium: 'Chrome',
  firefox: 'Firefox',
  webkit: 'Safari (macOS)',
}

/**
 * Where a Playwright build is known to differ from the branded browser of its column: the
 * capability is reported, not checked. Anything else that disagrees with the doc fails the test.
 */
const ENGINE_DIFFERENCES: Record<string, Partial<Record<Capability, string>>> = {
  chromium: {
    webShare: 'Chrome has navigator.share on Windows, macOS and ChromeOS, not in headless Chromium',
  },
  firefox: {},
  webkit: {
    webShare: "Safari's share sheet is Safari's own; Playwright's WebKit may not have it",
    // I4: Playwright's Linux WebKit (GTK) does not write any of src/record/format.ts' types;
    // Safari 14.1+ records MP4 (and WebM from 18.4). Real Safari: DEPLOY.md §5 step 25
    localRecording: "Playwright's Linux WebKit has no MediaRecorder format we record; Safari does",
  },
}

/**
 * Playwright's WebKit on Windows has no WebRTC at all (no RTCPeerConnection, no mediaDevices):
 * the media rows are not Safari's there, and the room shows its "use another browser" screen,
 * which this suite then checks instead
 */
const NO_WEBRTC_ROWS: Capability[] = [
  'webrtc',
  'getUserMedia',
  'getDisplayMedia',
  'shareAudio',
  'replaceTrack',
  'senderParameters',
  'audioContext',
  'audioProcessing',
  'advancedNoiseSuppression',
  'deviceChange',
]

async function detect(page: Page): Promise<Capabilities> {
  const code = await capabilityScript()
  // A string is evaluated by the browser's protocol, which no Content-Security-Policy stops
  return page.evaluate<Capabilities>(`${code}
__longtalkCapabilities.detectCapabilities()`)
}

/** Everything detection found in this browser, for the report */
function report(testInfo: TestInfo, name: string, data: unknown) {
  const dir = 'browser-report'
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/${testInfo.project.name}-${name}.json`, JSON.stringify(data, null, 2))
  return testInfo.attach(name, {
    body: JSON.stringify(data, null, 2),
    contentType: 'application/json',
  })
}

/** Whether this browser can be in a call at all; the rest of a test depends on it */
async function hasWebRtc(page: Page): Promise<boolean> {
  await page.goto('/')
  return (await detect(page)).webrtc
}

test('what LongTalk detects agrees with docs/BROWSER-SUPPORT.md', async ({
  page,
  browser,
}, testInfo) => {
  const column = COLUMN[testInfo.project.name]
  test.skip(!column, 'no doc column for this project')
  await page.goto('/')
  const detected = await detect(page)
  const marks = docMarks()
  const differences = { ...ENGINE_DIFFERENCES[testInfo.project.name] }
  if (!detected.webrtc) {
    for (const key of NO_WEBRTC_ROWS) differences[key] ??= 'this build of the engine has no WebRTC'
  }
  await report(testInfo, 'capabilities', {
    project: testInfo.project.name,
    version: browser.version(),
    userAgent: await page.evaluate(() => navigator.userAgent),
    column,
    detected,
    skipped: differences,
  })
  const disagreements: string[] = []
  for (const [key, value] of Object.entries(detected) as [Capability, boolean][]) {
    const mark = marks[key]?.[column]
    if (differences[key] || mark === '?' || mark === undefined) continue
    const expected = mark !== '✕'
    if (value !== expected) disagreements.push(`${key}: detected ${value}, doc says ${mark}`)
  }
  expect(disagreements, `${column} column of docs/BROWSER-SUPPORT.md`).toEqual([])
})

test('home page, and a room made from it', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: strings.tagline })).toBeVisible()
  // An invalid link is caught before anything is asked of the server
  await page.getByRole('textbox', { name: strings.home.joinLabel }).fill('nope')
  await page.getByRole('button', { name: strings.home.join, exact: true }).click()
  await expect(page.getByText(strings.home.joinInvalid)).toBeVisible()
  await page.getByRole('button', { name: strings.home.createRoom }).click()
  await expect(page).toHaveURL(/\/r\/\w{10}$/)
})

test('pre-join with a fake camera and microphone', async ({ page }) => {
  if (!(await hasWebRtc(page))) {
    // e2-t09: no WebRTC, so the room says to use another browser instead of failing later
    await page.goto(await newRoom(page))
    await expect(page.getByRole('heading', { name: strings.unsupported.title })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveText(strings.unsupported.body)
    return
  }
  const caps = await detect(page)
  const path = await newRoom(page)
  await openPreJoin(page, path)
  // The preview plays: its frames move on
  const preview = page.getByLabel(strings.prejoin.preview)
  await expect
    .poll(() => preview.evaluate((video: HTMLVideoElement) => video.videoWidth))
    .toBeGreaterThan(0)
  const time = await preview.evaluate((video: HTMLVideoElement) => video.currentTime)
  await expect
    .poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(time)
  // Devices are listed with their names (permission given), and nothing is wrong
  for (const label of [strings.prejoin.micLabel, strings.prejoin.camLabel]) {
    const select = page.getByRole('combobox', { name: label, exact: true })
    await expect(select).toBeEnabled()
    await expect(select.locator('option')).not.toHaveCount(0)
    await expect(select.locator('option').first()).not.toHaveText(strings.prejoin.noDevices)
  }
  await expect(page.getByRole('alert')).toHaveCount(0)
  // The speaker menu only where the browser can choose one (setSinkId)
  const speaker = page.getByRole('combobox', { name: strings.prejoin.speakerLabel, exact: true })
  if (!caps.setSinkId) await expect(speaker).toHaveCount(0)
  // The level meter is there (AudioContext); the fake microphone is not silent in every engine
  await expect(page.getByRole('meter', { name: strings.prejoin.micLevel })).toBeVisible()
  // Join, and the stage is there with our own tile
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill('Ada')
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
  await expect(page.getByRole('figure', { name: /Ada/ })).toBeVisible()
})

test('pre-join with the camera and microphone denied, then joining without them', async ({
  page,
}) => {
  test.skip(!(await hasWebRtc(page)), 'no WebRTC in this build: the room says so (test above)')
  // As when the person said no: the devices refuse and the permissions read denied. On the
  // prototypes: in WebKit, setting it on navigator.mediaDevices from an init script did not hold
  await page.addInitScript(() => {
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    })
    const query = Permissions.prototype.query
    Permissions.prototype.query = function (this: Permissions, descriptor: PermissionDescriptor) {
      return ['camera', 'microphone'].includes(descriptor.name)
        ? Promise.resolve({
            name: descriptor.name,
            state: 'denied',
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent: () => false,
          } as unknown as PermissionStatus)
        : query.call(this, descriptor)
    }
  })
  const path = await newRoom(page)
  await page.goto(path)
  await expect(page.getByRole('heading', { name: strings.prejoin.title })).toBeVisible()
  // The permission tutorial for this browser (G1), or the short notice where it cannot tell
  await expect(
    page
      .getByText(strings.permissionGuide.titleBoth)
      .or(page.getByText(strings.prejoin.problems.denied)),
  ).toBeVisible()
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill('Ada')
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
})

test('pre-join with no camera or microphone at all', async ({ page }) => {
  test.skip(!(await hasWebRtc(page)), 'no WebRTC in this build: the room says so (test above)')
  await page.addInitScript(() => {
    Object.defineProperty(MediaDevices.prototype, 'enumerateDevices', {
      configurable: true,
      value: () => Promise.resolve([]),
    })
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError')),
    })
  })
  const path = await newRoom(page)
  await page.goto(path)
  await expect(page.getByRole('heading', { name: strings.prejoin.title })).toBeVisible()
  await expect(
    page.getByText(
      `${strings.prejoin.problems.micNotFound}${strings.prejoin.problems.camNotFound}`,
    ),
  ).toBeVisible()
  for (const label of [strings.prejoin.micLabel, strings.prejoin.camLabel]) {
    const select = page.getByRole('combobox', { name: label, exact: true })
    await expect(select).toBeDisabled()
    await expect(select).toHaveText(strings.prejoin.noDevices)
  }
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill('Ada')
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
})

test('two members: the grid, chat and the participants panel', async ({ page, browser }) => {
  test.skip(!(await hasWebRtc(page)), 'no WebRTC in this build: the room says so (test above)')
  const caps = await detect(page)
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  const bobContext = await browser.newContext()
  const bob = await bobContext.newPage()
  await joinRoom(bob, path, 'Bob')
  await expect(page.getByRole('figure', { name: /Bob/ })).toBeVisible()
  await expect(bob.getByRole('figure', { name: /Ada/ })).toBeVisible()

  // Sharing is offered only where the browser can (getDisplayMedia)
  const toolbar = page.getByRole('toolbar', { name: strings.devices.controls })
  const share = toolbar.getByRole('button', { name: strings.toolbar.share, exact: true })
  await expect(share).toHaveCount(caps.getDisplayMedia ? 1 : 0)

  // Chat both ways, with a link that opens safely
  await toolbar.getByRole('button', { name: /^聊天/ }).click()
  const input = page.getByRole('textbox', { name: strings.chat.inputLabel })
  await expect(input).toBeFocused()
  await input.fill('哈囉 https://example.com/x')
  // The send button, inside the panel (Firefox once pushed it out, past the window's edge)
  const send = page.getByRole('button', { name: strings.chat.send, exact: true })
  await expect(send).toBeInViewport({ ratio: 1 })
  await send.click()
  const bobToolbar = bob.getByRole('toolbar', { name: strings.devices.controls })
  await expect(
    bobToolbar.getByRole('button', { name: strings.toolbar.chatUnread(1) }),
  ).toBeVisible()
  await bobToolbar.getByRole('button', { name: /^聊天/ }).click()
  const messages = bob.getByRole('log', { name: strings.chat.messages })
  await expect(messages.getByText('哈囉')).toBeVisible()
  await expect(messages.getByRole('link', { name: 'https://example.com/x' })).toHaveAttribute(
    'rel',
    /noopener/,
  )
  const bobInput = bob.getByRole('textbox', { name: strings.chat.inputLabel })
  // Typed key by key: Firefox's fill() is an input method's composition, and an Enter right after
  // one picks a candidate instead of sending (chatText.ts, COMPOSITION_GRACE_MS)
  await bobInput.pressSequentially('hi Ada')
  await bobInput.press('Enter')
  await expect(
    page.getByRole('log', { name: strings.chat.messages }).getByText('hi Ada'),
  ).toBeVisible()

  // The participants panel lists both
  await toolbar.getByRole('button', { name: /^參與者/ }).click()
  const list = page.getByRole('list', { name: strings.participants.list })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await bobContext.close()
})

test('a phone-sized window: the toolbar fits and nothing scrolls sideways', async ({
  browser,
  browserName,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    // Firefox has no mobile emulation in Playwright: only the size there
    ...(browserName === 'firefox' ? {} : { isMobile: true, hasTouch: true }),
    ...(browserName === 'webkit' ? { permissions: ['camera', 'microphone'] } : {}),
    ...(browserName === 'chromium' ? { permissions: ['camera', 'microphone'] } : {}),
  })
  const page = await context.newPage()
  test.skip(!(await hasWebRtc(page)), 'no WebRTC in this build: the room says so (test above)')
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  const toolbar = page.getByRole('toolbar', { name: strings.devices.controls })
  await expect(toolbar).toBeVisible()
  const box = await toolbar.boundingBox()
  expect(box, 'toolbar box').not.toBeNull()
  expect(box!.y + box!.height).toBeLessThanOrEqual(844)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  // No sharing button on a phone-sized screen (sharing is a computer's)
  await expect(
    toolbar.getByRole('button', { name: strings.toolbar.more, exact: true }),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await context.close()
})
