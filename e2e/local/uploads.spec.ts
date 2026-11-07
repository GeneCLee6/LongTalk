import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { FILE_CSP } from '../../shared/security-headers.ts'
import { filePath, thumbPath } from '../../shared/files.ts'
import { joinRoom, newRoom, secondMember, strings, viewports } from './helpers.ts'

// Files in chat (I5: e5-t05, e5-t06, AC-5.4) against the built app in `vite preview`: the Worker,
// the rooms and a local R2 bucket in workerd. Alice shares an image and a file; Bob sees both and
// downloads them; a blocked type never leaves her browser, and the API refuses it too. The viewer
// works by keyboard, no screen has an axe violation, and the phone layout holds.

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

// A real 4 × 4 red PNG: the browser really decodes it for the thumbnail
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARfQSAwCpcA/xdlSOGwAAAABJRU5ErkJggg==',
  'base64',
)
const PDF = Buffer.from('%PDF-1.7\n% LongTalk upload test\n')

const openChat = async (page: Page) => {
  await page
    .getByRole('toolbar', { name: strings.devices.controls })
    .getByRole('button', { name: /^聊天/ })
    .click()
  await expect(page.getByRole('textbox', { name: strings.chat.inputLabel })).toBeVisible()
}

const pick = (page: Page, name: string, mimeType: string, buffer: Buffer) =>
  page.getByTestId('chat-file-input').setInputFiles({ name, mimeType, buffer })

async function expectNoViolations(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`), label).toEqual(
    [],
  )
}

const tokenOf = (page: Page, roomId: string) =>
  page.evaluate((id) => {
    for (const store of [sessionStorage, localStorage]) {
      for (let i = 0; i < store.length; i++) {
        const value = store.getItem(store.key(i)!) ?? ''
        if (store.key(i)!.includes(id)) {
          const found = /[A-Za-z0-9_-]{43}/.exec(value)
          if (found) return found[0]
        }
      }
    }
    return null
  }, roomId)

test('Alice shares an image and a file; Bob sees and downloads them; a blocked type is refused', async ({
  browser,
  page,
  request,
}) => {
  const room = await newRoom(page)
  const roomId = room.split('/').at(-1)!
  await joinRoom(page, room, 'Alice')
  const bob = await secondMember(browser, room, 'Bob')
  await openChat(page)
  await openChat(bob.page)

  // A blocked type: refused in her browser, in words, with nothing to retry
  await pick(page, 'virus.exe', 'application/octet-stream', Buffer.from('MZ'))
  const refusal = page.getByRole('alert').filter({ hasText: strings.chat.file.problems.blockedType })
  await expect(refusal).toBeVisible()
  await expect(
    page.getByRole('button', { name: strings.chat.file.retry('virus.exe') }),
  ).toHaveCount(0)
  await expectNoViolations(page, 'an upload refused')
  await page.getByRole('button', { name: strings.chat.file.dismiss('virus.exe') }).click()
  await expect(refusal).toHaveCount(0)

  // An image: its thumbnail is made here and fetched by Bob, who never asks for the original
  const thumbFetches: string[] = []
  bob.page.on('request', (r) => {
    if (r.url().includes('/api/files/')) thumbFetches.push(r.url())
  })
  await pick(page, '照片.png', 'image/png', PNG)
  const open = bob.page.getByRole('button', { name: strings.chat.file.view('照片.png') })
  await expect(open).toBeVisible()
  await expect(open.locator('img')).toHaveJSProperty('complete', true)
  await expect.poll(() => open.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(4)
  expect(thumbFetches.every((url) => url.endsWith('/thumb'))).toBe(true)
  await expect(page.getByRole('button', { name: strings.chat.file.view('照片.png') })).toBeVisible()

  // A file: Bob sees its card, name, size and type, and downloads the same bytes
  await pick(page, '報告.pdf', 'application/pdf', PDF)
  await expect(bob.page.getByText('報告.pdf')).toBeVisible()
  await expect(bob.page.getByText(/ B · PDF$/)).toBeVisible()
  const pdf = bob.page.waitForEvent('download')
  await bob.page.getByRole('button', { name: strings.chat.file.download('報告.pdf') }).click()
  const pdfFile = await pdf
  expect(pdfFile.suggestedFilename()).toBe('報告.pdf')
  expect(readFileSync(await pdfFile.path()).equals(PDF)).toBe(true)
  await expectNoViolations(bob.page, 'chat with file and image cards')

  // The viewer, by keyboard: Enter opens, focus moves in, Esc closes, focus returns
  await open.focus()
  await bob.page.keyboard.press('Enter')
  const viewer = bob.page.getByRole('dialog', { name: '照片.png' })
  await expect(viewer).toBeVisible()
  await expect(viewer.getByRole('img', { name: '照片.png' })).toBeVisible()
  await expect(viewer.getByRole('button', { name: strings.common.close })).toBeFocused()
  await expectNoViolations(bob.page, 'image viewer')
  await bob.page.keyboard.press('Tab')
  await expect(viewer.locator(':focus')).toHaveCount(1)
  const image = bob.page.waitForEvent('download')
  await viewer.getByRole('button', { name: strings.chat.file.download('照片.png') }).click()
  const imageFile = await image
  expect(imageFile.suggestedFilename()).toBe('照片.png')
  expect(readFileSync(await imageFile.path()).equals(PNG)).toBe(true)
  await bob.page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(open).toBeFocused()
  // The chat is still open: Esc belonged to the viewer
  await expect(bob.page.getByRole('textbox', { name: strings.chat.inputLabel })).toBeVisible()

  // Someone joining later gets the cards with the history
  const carol = await secondMember(browser, room, 'Carol')
  await openChat(carol.page)
  await expect(carol.page.getByText('報告.pdf')).toBeVisible()

  // The API itself: only members; the headers that keep a file from running as this origin
  const token = await tokenOf(bob.page, roomId)
  expect(token).not.toBeNull()
  const message = await bob.page.evaluate(() => {
    const list = [...performance.getEntriesByType('resource')]
    const entry = list.find((e) => /\/api\/files\/[^/]+\/[^/]+\/thumb$/.test(e.name))
    return entry ? new URL(entry.name).pathname : null
  })
  expect(message).not.toBeNull()
  const fileId = message!.split('/')[4]
  expect((await request.get(filePath(roomId, fileId))).status()).toBe(401)
  expect(
    (
      await request.get(thumbPath(roomId, fileId), {
        headers: { authorization: `Bearer ${'x'.repeat(43)}` },
      })
    ).status(),
  ).toBe(401)
  if (token) {
    const answer = await request.get(thumbPath(roomId, fileId), {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(answer.status()).toBe(200)
    const headers = answer.headers()
    expect(headers['content-type']).toBe('image/jpeg')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['content-security-policy']).toBe(FILE_CSP)
    expect(headers['cache-control']).toBe('private, no-store')
    const blocked = await request.post(`/api/files/${roomId}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: 'x.html', size: 10, type: 'text/html', thumb: false },
    })
    expect(blocked.status()).toBe(415)
    // A page dressed as a text file passes the announcement, and the bytes give it away
    const granted = await request.post(`/api/files/${roomId}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: 'notes.txt', size: 30, type: 'text/plain', thumb: false },
    })
    expect(granted.status()).toBe(201)
    const { id } = (await granted.json()) as { id: string }
    const sniffed = await request.put(filePath(roomId, id), {
      headers: { authorization: `Bearer ${token}` },
      data: Buffer.from('<html><script>x</script></html>'.slice(0, 30)),
    })
    expect(sniffed.status()).toBe(415)
    // A size the grant did not announce: never stored
    const lying = await request.post(`/api/files/${roomId}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: 'notes.txt', size: 5, type: 'text/plain', thumb: false },
    })
    const lyingId = ((await lying.json()) as { id: string }).id
    const tooMuch = await request.put(filePath(roomId, lyingId), {
      headers: { authorization: `Bearer ${token}` },
      data: Buffer.from('more than five bytes'),
    })
    expect(tooMuch.status()).toBe(400)
  }
  await bob.context.close()
  await carol.context.close()
})

test('an upload shows progress and can be cancelled; a failure says why', async ({ page }) => {
  const room = await newRoom(page)
  await joinRoom(page, room, 'Alice')
  await openChat(page)
  // Held on the way out until cancelled, so the row can be looked at: a fixed wait can run out during
  // the axe scan on a slow machine, and the row and its cancel button go with it
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/files/*/*', async (route) => {
    await held
    await route.continue().catch(() => {})
  })
  await pick(page, 'slow.zip', 'application/zip', Buffer.alloc(200_000, 7))
  const bar = page.getByRole('progressbar', { name: strings.chat.file.uploading('slow.zip') })
  await expect(bar).toBeVisible()
  await expectNoViolations(page, 'an upload under way')
  await page.getByRole('button', { name: strings.chat.file.cancel('slow.zip') }).click()
  await expect(bar).toHaveCount(0)
  release()
  await page.unroute('**/api/files/*/*')
  // A cancelled upload never shows up in the chat
  await expect(page.getByText('slow.zip')).toHaveCount(0)

  // The connection dies while the bytes go out
  await page.route('**/api/files/*/*', (route) => route.abort())
  await pick(page, 'lost.zip', 'application/zip', Buffer.alloc(1000, 7))
  await expect(
    page.getByRole('alert').filter({ hasText: strings.chat.file.problems.network }),
  ).toBeVisible()
  await page.unroute('**/api/files/*/*')
  await page.getByRole('button', { name: strings.chat.file.retry('lost.zip') }).click()
  await expect(page.getByText('lost.zip')).toBeVisible()
  await expect(page.getByRole('button', { name: strings.chat.file.download('lost.zip') })).toBeVisible()
})

test('on a phone the picker, the card and the viewer fit the screen', async ({ browser }) => {
  const context = await browser.newContext(viewports.phone)
  const page = await context.newPage()
  const room = await newRoom(page)
  await joinRoom(page, room, 'Alice')
  await page
    .getByRole('toolbar', { name: strings.devices.controls })
    .getByRole('button', { name: /^聊天/ })
    .click()
  const dialog = page.getByRole('dialog', { name: strings.chat.title })
  await expect(dialog).toBeVisible()
  const attach = dialog.getByRole('button', { name: strings.chat.file.attach })
  await expect(attach).toBeVisible()
  // The system's picker opens from the button, as a tap needs it to
  const chooser = page.waitForEvent('filechooser')
  await attach.click()
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG })
  const open = dialog.getByRole('button', { name: strings.chat.file.view('photo.png') })
  await expect(open).toBeVisible()
  await expectNoViolations(page, 'phone chat with an image')
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await open.click()
  const viewer = page.getByRole('dialog', { name: 'photo.png' })
  await expect(viewer.getByRole('img', { name: 'photo.png' })).toBeVisible()
  await expectNoViolations(page, 'phone image viewer')
  const box = await viewer.boundingBox()
  expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 })
  await viewer.getByRole('button', { name: strings.common.close }).click()
  await expect(viewer).toHaveCount(0)
  await context.close()
})
