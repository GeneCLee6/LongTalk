import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The desktop agent's bundled UI (agent/README.md): built into agent/ui/dist, which Tauri embeds
// (tauri.conf.json frontendDist). Not part of the web app's build or its JS budget. It imports
// shared/ and src/media/ from the repository root (the same MediaTransport as the web app,
// CLAUDE.md rule 2), so the dev server may read the whole repository.
const here = fileURLToPath(new URL('.', import.meta.url))
const repo = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  root: here,
  plugins: [react()],
  // Tauri's dev server URL (tauri.conf.json devUrl)
  server: { port: 5174, strictPort: true, fs: { allow: [repo] } },
  clearScreen: false,
  envPrefix: [],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // WebView2 (Windows 10+) and WKWebView (macOS 12+): no older browsers to support
    target: ['chrome110', 'safari16'],
  },
})
