import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom has no WebRTC; the room page refuses a browser without RTCPeerConnection (e2-t09). The
// media itself runs on FakeTransport; a page using the real transport fails to connect, as before.
if (typeof globalThis.RTCPeerConnection === 'undefined') {
  globalThis.RTCPeerConnection = class {
    constructor() {
      throw new Error('No WebRTC in jsdom')
    }
  } as unknown as typeof RTCPeerConnection
}

afterEach(() => {
  cleanup()
})
