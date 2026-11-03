import { expect, type Browser, type BrowserContextOptions, type Page } from '@playwright/test'
// The browsers run in zh-TW (playwright.local.config.ts)
import { zhTW as strings } from '../../src/i18n/zh-TW.ts'

export { strings }

/** The two window sizes of the visual tests and the accessibility checks */
export const viewports = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  },
} satisfies Record<string, BrowserContextOptions>

export type ViewportName = keyof typeof viewports

/** A new room from the API; gives its path */
export async function newRoom(page: Page): Promise<string> {
  const response = await page.request.post('/api/rooms')
  expect(response.ok()).toBe(true)
  const { id } = (await response.json()) as { id: string }
  return `/r/${id}`
}

/** Opens the room's pre-join screen and waits for the camera preview */
export async function openPreJoin(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: strings.prejoin.title })).toBeVisible()
  await expect(page.getByLabel(strings.prejoin.preview)).toBeVisible()
}

/** Joins through the pre-join screen with this name and waits for the stage */
export async function joinRoom(page: Page, path: string, name: string): Promise<void> {
  await openPreJoin(page, path)
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill(name)
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
}

/** Another member (a context of its own) in the same room; close the context when done */
export async function secondMember(browser: Browser, path: string, name: string, phone = false) {
  const context = await browser.newContext(phone ? viewports.phone : viewports.desktop)
  const page = await context.newPage()
  await joinRoom(page, path, name)
  return { context, page }
}
