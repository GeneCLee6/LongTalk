/// <reference types="vitest/config" />
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

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

// The Cloudflare plugin runs the Worker (API, Durable Objects) inside `vite dev` and builds it
// next to the client; it is left out of Vitest, which tests the Worker's logic directly.
export default defineConfig({
  plugins: [react(), appVersion(), ...(process.env.VITEST ? [] : [cloudflare()])],
  // scripts/budget.ts reads the manifest to know which chunks each page loads
  build: { manifest: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
