import { createRoot } from 'react-dom/client'
import { VideoDemandContext } from '../../../src/components/useVideoDemand.ts'
import { ShareTile } from '../../../src/components/ShareTile.tsx'
import { VideoDemandStore } from '../../../src/room/videoDemand.ts'
import { GlobalStyle } from '../../../src/styles/GlobalStyle.ts'

// The real ShareTile showing a real <video> (e2e/local/annotation.spec.ts): `vite preview` has no
// Realtime SFU, so no share ever reaches a room there. The picture is a canvas with known marks,
// so the test can check where they land on screen: a dark background, a bright square centred at
// (0.25, 0.25) and another at (0.75, 0.75), each 8% of the picture across.

const params = new URLSearchParams(location.search)
const width = Number(params.get('w') ?? 1600)
const height = Number(params.get('h') ?? 900)

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
  }
}
window.shareDemand = () => demand.get(track)

createRoot(document.getElementById('root')!).render(
  <VideoDemandContext.Provider value={demand}>
    <GlobalStyle />
    <div data-theme="dark" style={{ width: '100%', height: '100%' }}>
      <ShareTile name="Bob" video={track} annotator="me" recording="Gene 正在錄影" />
    </div>
  </VideoDemandContext.Provider>,
)
