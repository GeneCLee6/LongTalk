import { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { SharingBar } from '../../../src/components/SharingBar.tsx'
import { useSharePip } from '../../../src/room/useSharePip.ts'
import { VideoDemandContext } from '../../../src/components/useVideoDemand.ts'
import { SharePicker } from '../../../src/components/SharePicker.tsx'
import { ShareTile } from '../../../src/components/ShareTile.tsx'
import { AnnotationStore } from '../../../src/room/annotationStore.ts'
import { loadDictionary } from '../../../src/strings.ts'
import { VideoDemandStore } from '../../../src/room/videoDemand.ts'
import { GlobalStyle } from '../../../src/styles/GlobalStyle.ts'

// The real ShareTile showing a real <video> (e2e/local/annotation.spec.ts): `vite preview` has no
// Realtime SFU, so no share ever reaches a room there. The picture is a canvas with known marks,
// so the test can check where they land on screen: a dark background, a bright square centred at
// (0.25, 0.25) and another at (0.75, 0.75), each 8% of the picture across.

const params = new URLSearchParams(location.search)
const width = Number(params.get('w') ?? 1600)
const height = Number(params.get('h') ?? 900)
/** The sharer's own view (J3): `window`, or `screen` for a whole screen (the mirror risk) */
const own = params.get('own')
/**
 * The sharer's floating window (Document Picture-in-Picture): `window`, or `screen` for a whole
 * screen. The sharing bar's real button opens a real window; `drawOnShare` adds Bob's stroke
 */
const pip = params.get('pip')
const SharePip = lazy(() => import('../../../src/annotate/SharePip.tsx'))

const canvas = document.createElement('canvas')
canvas.width = width
canvas.height = height
const context = canvas.getContext('2d')!
const paint = () => {
  context.fillStyle = 'rgb(0, 0, 60)'
  context.fillRect(0, 0, width, height)
  context.fillStyle = 'rgb(0, 255, 0)'
  for (const at of [0.25, 0.75]) {
    context.fillRect((at - 0.04) * width, (at - 0.04) * height, 0.08 * width, 0.08 * height)
  }
}
paint()
// A captured canvas only sends frames when it is drawn on
setInterval(paint, 100)
const track = canvas.captureStream(10).getVideoTracks()[0]

const demand = new VideoDemandStore()
declare global {
  interface Window {
    shareDemand: () => unknown
    picked: string[]
    /** Every frame the toolbar and the canvas send to the room (there is no room here) */
    annotateFrames: unknown[]
    /** Bob draws a thick line across the middle of our share (the floating window's harness) */
    drawOnShare: (id: string) => void
  }
}
window.shareDemand = () => demand.get(track)
window.picked = []
window.annotateFrames = []
const store = new AnnotationStore({
  send: (message) => window.annotateFrames.push(message),
  isOpen: () => true,
})
window.drawOnShare = (id) =>
  store.receive({
    t: 'annotation',
    share: 'me',
    by: 'bob',
    ops: [
      {
        op: 'add',
        stroke: {
          id,
          by: 'bob',
          tool: 'pen',
          color: 'rose',
          width: 'thick',
          points: [
            [0.1, 0.5],
            [0.9, 0.5],
          ],
        },
      },
    ],
  })

/** The sharing bar with its floating window button, and the window once open */
function PipHarness({ mirrorRisk }: { mirrorRisk: boolean }) {
  const floating = useSharePip(true)
  return (
    <>
      <SharingBar
        onStop={() => {}}
        pip={
          floating.supported
            ? {
                open: floating.window !== null,
                onToggle: floating.window ? floating.close : floating.open,
              }
            : null
        }
      />
      {floating.window && (
        <Suspense fallback={null}>
          <SharePip
            pipWindow={floating.window}
            track={track}
            store={store}
            layer="me"
            nameOf={(id) => (id === 'bob' ? 'Bob' : null)}
            mirrorRisk={mirrorRisk}
          />
        </Suspense>
      )}
    </>
  )
}

const shares = [
  { id: 'b', name: 'Bob' },
  { id: 'c', name: 'Carol' },
]

// Not through App: the tile reads what the room's lazy pages read, which they load first (J4)
await loadDictionary()

const root = createRoot(document.getElementById('root')!)
if (pip) {
  root.render(
    <>
      <GlobalStyle />
      <div data-theme="dark">
        <PipHarness mirrorRisk={pip === 'screen'} />
      </div>
    </>,
  )
} else
  root.render(
    <VideoDemandContext.Provider value={demand}>
      <GlobalStyle />
      <div data-theme="dark" style={{ width: '100%', height: '100%' }}>
        <ShareTile
          name="Bob"
          video={track}
          annotations={{
            store,
            share: 'b',
            me: 'me',
            manage: own !== null,
            nameOf: () => null,
            roomName: '週會',
          }}
          own={own ? { mirrorRisk: own === 'screen' } : null}
          recording="Gene 正在錄影"
          picker={<SharePicker shares={shares} main="b" onPick={(id) => window.picked.push(id)} />}
        />
      </div>
    </VideoDemandContext.Provider>,
  )
