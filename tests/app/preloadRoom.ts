import { beforeAll, vi } from 'vitest'

/**
 * For a file whose tests open a room through App. Loads the lazy room chunk
 * (src/pages/RoomPage.tsx) before the tests: the first test to open a room otherwise pays for
 * transforming it inside its own 5-second limit, which a machine running every file in parallel
 * can exceed. Once loaded, App's lazy() import resolves from the module cache, so this costs
 * nothing extra. The first full render of the room (styles injected, code warmed up) still takes
 * about a second on its own, several under load: this file's tests get 15 seconds instead of 5
 * (a passing test is no slower; only a hanging one takes longer to fail).
 */
export function preloadRoomPage(): void {
  vi.setConfig({ testTimeout: 15_000 })
  beforeAll(async () => {
    await import('../../src/pages/RoomPage.tsx')
  }, 60_000)
}
