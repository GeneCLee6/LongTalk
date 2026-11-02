import { describe, expect, it } from 'vitest'
import indexHtml from '../../index.html?raw'
import headers from '../../public/_headers?raw'
import manifestText from '../../public/manifest.webmanifest?raw'
import faviconSvg from '../../public/favicon.svg?raw'
import logoFavicon from '../../docs/design/logo/favicon.svg?raw'
import {
  BRAND_DESCRIPTION,
  ICONS,
  OG_IMAGE,
  SITE_URL,
  THEME_COLORS,
  webManifest,
} from '../../src/brand.ts'

// e4-t19: what is committed in public/ and index.html is what src/brand.ts says (run
// `npm run brand` after changing either), and the name is English only.

/** Every committed image, as base64 data URLs */
const images = import.meta.glob<string>('../../public/**/*.{png,ico}', {
  query: '?inline',
  import: 'default',
  eager: true,
})

function bytesOf(file: string): Uint8Array {
  const dataUrl = images[`../../public/${file}`]
  expect(dataUrl, `public/${file} is committed`).toBeDefined()
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** A PNG's width and height from its IHDR chunk */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.slice(0, 8)]).toEqual(PNG_SIGNATURE)
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Han characters: none may appear in the name (PRD §14: the name is English only) */
const HAN = /\p{Script=Han}/u

const meta = (attribute: 'name' | 'property', key: string): string[] =>
  [...indexHtml.matchAll(new RegExp(`<meta\\s+${attribute}="${key}"[^>]*>`, 'g'))].map(
    ([tag]) => /content="([^"]*)"/.exec(tag)?.[1] ?? '',
  )

describe('brand files (e4-t19)', () => {
  it('commits the manifest that src/brand.ts describes, named LongTalk only', () => {
    const manifest = JSON.parse(manifestText) as ReturnType<typeof webManifest>
    expect(manifest).toEqual(webManifest())
    expect(manifest.name).toBe('LongTalk')
    expect(manifest.short_name).toBe('LongTalk')
    expect(manifest.start_url).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.filter((icon) => icon.purpose === 'maskable')).not.toHaveLength(0)
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    )
  })

  it('renders every icon at its size, and every manifest icon exists', () => {
    for (const { file, size } of ICONS) {
      const bytes = bytesOf(file)
      if (file.endsWith('.ico')) {
        // An ICO directory with one PNG inside
        expect([...bytes.slice(0, 6)]).toEqual([0, 0, 1, 0, 1, 0])
        expect(bytes[6]).toBe(size)
        expect(pngSize(bytes.slice(22))).toEqual({ width: size, height: size })
      } else {
        expect(pngSize(bytes), file).toEqual({ width: size, height: size })
      }
    }
    for (const icon of webManifest().icons) {
      if (icon.type !== 'image/png') continue
      const [width, height] = icon.sizes.split('x').map(Number)
      expect(pngSize(bytesOf(icon.src.slice(1)))).toEqual({ width, height })
    }
  })

  it('has a 1200×630 Open Graph image', () => {
    expect(pngSize(bytesOf(OG_IMAGE.file))).toEqual({
      width: OG_IMAGE.width,
      height: OG_IMAGE.height,
    })
  })

  it('serves the favicon from docs/design/logo unchanged', () => {
    expect(faviconSvg.trim()).toBe(logoFavicon.trim())
  })

  it('links the icons, the manifest and the Open Graph tags from index.html', () => {
    expect(indexHtml).toContain('<title>LongTalk</title>')
    expect(indexHtml).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />')
    expect(indexHtml).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />')
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(meta('property', 'og:title')).toEqual(['LongTalk'])
    expect(meta('name', 'twitter:title')).toEqual(['LongTalk'])
    expect(meta('name', 'application-name')).toEqual(['LongTalk'])
    expect(meta('name', 'apple-mobile-web-app-title')).toEqual(['LongTalk'])
    expect(meta('property', 'og:site_name')).toEqual(['LongTalk'])
    expect(meta('property', 'og:image')).toEqual([`${SITE_URL}/${OG_IMAGE.file}`])
    expect(meta('property', 'og:image:width')).toEqual([String(OG_IMAGE.width)])
    expect(meta('property', 'og:image:height')).toEqual([String(OG_IMAGE.height)])
    expect(meta('name', 'twitter:card')).toEqual(['summary_large_image'])
    expect(meta('name', 'description')).toEqual([BRAND_DESCRIPTION])
    expect(meta('property', 'og:description')).toEqual([BRAND_DESCRIPTION])
    // The browser bar takes the page background of each scheme (tokens.ts)
    expect(meta('name', 'theme-color')).toEqual([THEME_COLORS.light, THEME_COLORS.dark])
  })

  it('never names the product in Chinese', () => {
    const names = [
      webManifest().name,
      webManifest().short_name,
      ...meta('property', 'og:title'),
      ...meta('property', 'og:site_name'),
      ...meta('property', 'og:image:alt'),
      ...meta('name', 'twitter:title'),
      ...meta('name', 'application-name'),
      ...meta('name', 'apple-mobile-web-app-title'),
      /<title>([^<]*)<\/title>/.exec(indexHtml)?.[1] ?? '',
    ]
    for (const name of names) expect(name).not.toMatch(HAN)
    expect(logoFavicon + faviconSvg).not.toMatch(HAN)
  })

  it('caches the brand files for a while, and not the app chunks (SPA fallback)', () => {
    expect(headers).not.toMatch(/^\/assets/m)
    expect(headers).toMatch(/\/manifest\.webmanifest\n\s+Content-Type: application\/manifest\+json/)
    for (const { file } of ICONS) {
      const covered = headers.includes(`/${file}\n`) || headers.includes(`/${file.split('/')[0]}/*`)
      expect(covered, `${file} has a cache header`).toBe(true)
    }
  })
})
