import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'
import { setLocale } from '../src/strings.ts'

// jsdom has no WebRTC; the room page refuses a browser without RTCPeerConnection (e2-t09). The
// media itself runs on FakeTransport; a page using the real transport fails to connect, as before.
if (typeof globalThis.RTCPeerConnection === 'undefined') {
  globalThis.RTCPeerConnection = class {
    constructor() {
      throw new Error('No WebRTC in jsdom')
    }
  } as unknown as typeof RTCPeerConnection
}

// The room page is a lazy chunk: on a busy CI runner the first test of a file that opens it can
// wait more than Testing Library's default second for it to load and render (G3 made the page a
// little larger). findBy* and waitFor wait up to 4 s, under Vitest's 5 s per test; a passing
// test still returns at once.
configure({ asyncUtilTimeout: 4_000 })

// The tests read Chinese (the default locale, G1; tests/setupLocale.ts): start every
// test in zh-TW without remembering it; a test that switches to English is undone here
beforeEach(() => {
  setLocale('zh-TW', false)
})

afterEach(() => {
  cleanup()
})
