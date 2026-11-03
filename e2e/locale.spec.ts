import { expect, test } from '@playwright/test'
import { en } from '../src/i18n/en.ts'
import { zhTW } from '../src/i18n/zh-TW.ts'

// G1 (e4-t15): a browser whose languages are all English starts in English, through the home
// page into a new room's pre-join screen; switching to 繁體中文 there is remembered on reload.
test('an English browser gets English, and the switch is remembered', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-AU' })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: en.tagline })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await page.getByRole('button', { name: en.home.createRoom }).click()
  await expect(page.getByRole('heading', { name: en.prejoin.title })).toBeVisible()
  await expect(page.getByRole('textbox', { name: en.prejoin.nameLabel })).toBeVisible()
  await page.getByRole('combobox', { name: en.language.label }).selectOption('zh-TW')
  await expect(page.getByRole('heading', { name: zhTW.prejoin.title })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: zhTW.prejoin.title })).toBeVisible()
  await context.close()
})
