// Builds the service worker (e4-t12, DEPLOY.md §10) into dist/client/sw.js: src/pwa/sw.ts is
// bundled as a chunk of its own (Vite's bundler, so it is minified like the app), then written
// out as /sw.js with this build's file list in front:
//
//   self.__LT_SW__={"version":"<hash>","appVersion":"<commit>","precache":["/","/assets/…"]};
//
// Hand-written rather than vite-plugin-pwa / Workbox: the worker only needs three strategies
// (swRouting.ts), stays about 2 kB, adds no dependency to keep in step with Vite 8 and the
// Cloudflare plugin, and its rules (never /api/*) are ours to test. Reproducible: the version is
// a hash of the file list, index.html without its app-version meta and the worker's own code,
// so the same sources give the same sw.js, and a deploy that changes nothing the browser runs
// (a docs-only commit) does not show 「有新版本」.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { SW_URL, precacheUrls } from '../src/pwa/swRouting.ts'

const SOURCE = fileURLToPath(new URL('../src/pwa/sw.ts', import.meta.url))
const APP_VERSION_META = /<meta name="app-version" content="[^"]*"\s*\/?>/

export function serviceWorker(appVersion: string): Plugin {
  let ref = ''
  return {
    name: 'longtalk-service-worker',
    apply: 'build',
    // Only the browser's build: the Worker (Cloudflare plugin) has no service worker
    applyToEnvironment: (environment) => environment.name === 'client',
    buildStart() {
      ref = this.emitFile({ type: 'chunk', id: SOURCE, name: 'sw' })
    },
    generateBundle(_options, bundle) {
      const fileName = this.getFileName(ref)
      const chunk = bundle[fileName]
      if (!chunk || chunk.type !== 'chunk') this.error('service worker chunk missing')
      // sw.js is a classic script (module workers are not everywhere yet): nothing to import
      if (
        chunk.imports.length > 0 ||
        chunk.dynamicImports.length > 0 ||
        /^\s*(import|export)\b/m.test(chunk.code)
      ) {
        this.error(`sw.ts must not share code with the app (imports: ${chunk.imports.join(', ')})`)
      }
      delete bundle[fileName]
      const html = bundle['index.html']
      const shell = html && html.type === 'asset' ? String(html.source) : ''
      const precache = precacheUrls(Object.keys(bundle))
      const version = createHash('sha256')
        .update(JSON.stringify(precache))
        .update(shell.replace(APP_VERSION_META, ''))
        .update(chunk.code)
        .digest('hex')
        .slice(0, 16)
      const header = `self.__LT_SW__=${JSON.stringify({ version, appVersion, precache })};\n`
      // Wrapped in a function: the minified top-level names stay out of the worker's globals
      const source = `${header}(()=>{${chunk.code}})();\n`
      this.emitFile({ type: 'asset', fileName: SW_URL.slice(1), source })
    },
  }
}
