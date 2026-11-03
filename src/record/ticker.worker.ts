// The local recording's frame clock (I4, e8-t01): a worker's timer keeps its rate in a
// background tab, where the page's own timers are slowed to once a second or less. The page
// posts the interval in ms (0 stops it) and draws a frame on every message back.

/** The dedicated worker's scope, as far as this needs it (the app's types are the DOM's) */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<number>) => void) | null
  postMessage(message: number): void
}

let timer: ReturnType<typeof setInterval> | null = null

scope.onmessage = (event) => {
  if (timer !== null) clearInterval(timer)
  timer = null
  const ms = event.data
  if (typeof ms === 'number' && ms > 0) timer = setInterval(() => scope.postMessage(0), ms)
}
