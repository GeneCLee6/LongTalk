/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { serviceWorker } from './scripts/swPlugin.ts'

// Stamps the built commit into index.html so a deployment can be traced back to its commit.
// The deploy workflows set APP_VERSION to the commit they deploy.
const appVersion = (): Plugin => ({
  name: 'app-version',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { name: 'app-version', content: process.env.APP_VERSION ?? 'local' },
      injectTo: 'head',
    },
  ],
})

// The licenses of third-party code the browser gets (RNNoise's wasm, e6-t02) go out with the
// app as /third-party-notices.txt, from THIRD_PARTY_NOTICES.md
const thirdPartyNotices = (): Plugin => ({
  name: 'third-party-notices',
  apply: 'build',
  generateBundle() {
    if (this.environment && this.environment.name !== 'client') return
    this.emitFile({
      type: 'asset',
      fileName: 'third-party-notices.txt',
      source: readFileSync('THIRD_PARTY_NOTICES.md', 'utf8'),
    })
  },
})

// The Cloudflare plugin runs the Worker (API, Durable Objects) inside `vite dev` and builds it
// next to the client; it is left out of Vitest, which tests the Worker's logic directly.
export default defineConfig({
  plugins: [
    react(),
    appVersion(),
    thirdPartyNotices(),
    // The app shell's service worker (e4-t12): dist/client/sw.js, with this build's file list
    serviceWorker(process.env.APP_VERSION ?? 'local'),
    ...(process.env.VITEST ? [] : [cloudflare()]),
  ],
  // scripts/budget.ts reads the manifest to know which chunks each page loads
  build: { manifest: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setupLocale.ts', './tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
