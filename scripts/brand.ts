// Renders the brand files in public/ from docs/design/logo/ (e4-t19): the favicons, the app and
// home-screen icons, the Open Graph image and the web app manifest. The output is committed; run
// this again after changing a logo SVG, src/brand.ts or the colours in src/styles/tokens.ts:
//
//   npm run brand
//
// Uses the Chromium that Playwright already installed (npx playwright install chromium), so the
// SVGs render exactly as a browser draws them. Text on the Open Graph image uses the brand font
// stack (Inter, else the system sans-serif): another machine may draw it slightly differently.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { BRAND_TAGLINE, ICONS, OG_IMAGE, webManifest } from '../src/brand.ts'
import { zhTW as strings } from '../src/i18n/zh-TW.ts'
import { font, palette } from '../src/styles/tokens.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const logoDir = join(root, 'docs/design/logo')
const publicDir = join(root, 'public')

async function write(file: string, data: string | Uint8Array) {
  const path = join(publicDir, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
  console.log(`wrote public/${file}`)
}

/** An .ico holding one PNG (every browser since Vista-era IE reads PNG inside ICO) */
function icoFromPng(png: Uint8Array, size: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(6 + 16))
  header.setUint16(0, 0, true) // reserved
  header.setUint16(2, 1, true) // type: icon
  header.setUint16(4, 1, true) // one image
  header.setUint8(6, size >= 256 ? 0 : size) // width
  header.setUint8(7, size >= 256 ? 0 : size) // height
  header.setUint8(8, 0) // no palette
  header.setUint8(9, 0) // reserved
  header.setUint16(10, 1, true) // colour planes
  header.setUint16(12, 32, true) // bits per pixel
  header.setUint32(14, png.length, true) // image size
  header.setUint32(18, 6 + 16, true) // image offset
  const out = new Uint8Array(6 + 16 + png.length)
  out.set(new Uint8Array(header.buffer), 0)
  out.set(png, 6 + 16)
  return out
}

/** The Open Graph card: the mark and the English name and line on the brand colour */
async function ogHtml(): Promise<string> {
  const mark = (await readFile(join(logoDir, 'logo-mark.svg'), 'utf8'))
    // White on the brand colour; drop the light/dark styles of the page logo
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(
      /class="k"/,
      `fill="none" stroke="${palette.light.onPrimary}" stroke-width="6.5" ` +
        'stroke-linecap="round" stroke-linejoin="round"',
    )
    .replace(/class="t"/g, `fill="${palette.light.onPrimary}"`)
    .replace(/width="64" height="64"/, 'width="220" height="220"')
  const { width, height } = OG_IMAGE
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; }
    body {
      width: ${width}px; height: ${height}px; box-sizing: border-box;
      display: flex; align-items: center; gap: 56px; padding: 0 110px;
      background: ${palette.light.primary}; color: ${palette.light.onPrimary};
      font-family: ${font.brand};
    }
    h1 { margin: 0; font-size: 132px; font-weight: 700; letter-spacing: -3px; line-height: 1; }
    p { margin: 22px 0 0; font-size: 40px; font-weight: 400; color: ${palette.light.primarySoft}; }
  </style></head><body>${mark}<div><h1>${strings.appName}</h1><p>${BRAND_TAGLINE}</p></div></body></html>`
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const { file, from, size, square } of ICONS) {
    const source = await readFile(join(logoDir, from), 'utf8')
    const svg = square ? source.replace(/ rx="[\d.]+"/, '') : source
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    )
    const png = await page.screenshot({ omitBackground: true, type: 'png' })
    await write(file, file.endsWith('.ico') ? icoFromPng(png, size) : png)
  }

  await page.setViewportSize({ width: OG_IMAGE.width, height: OG_IMAGE.height })
  await page.setContent(await ogHtml())
  await write(OG_IMAGE.file, await page.screenshot({ type: 'png' }))
} finally {
  await browser.close()
}

await write('favicon.svg', await readFile(join(logoDir, 'favicon.svg')))
await write('manifest.webmanifest', `${JSON.stringify(webManifest(), null, 2)}\n`)
