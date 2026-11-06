// The recording's picture (I4, e8-t01): each frame, the scene (src/record/scene.ts) drawn on one
// canvas that MediaRecorder records through canvas.captureStream. The colours are the room's own
// (styles/tokens.ts: the room is always dark), the nameplates like the tiles'. One canvas and
// one off-screen <video> per track for the whole recording: a video element is made when a track
// appears and let go when it leaves, nothing is made per frame.
import { drawStroke } from '../annotate/draw.ts'
import { strings } from '../strings.ts'
import { avatar, avatarColor, font, palette } from '../styles/tokens.ts'
import {
  fitVideo,
  placeScene,
  type Placement,
  type Rect,
  type Scene,
  type SceneShare,
} from './scene.ts'

const colors = palette.dark

/** The 2D context calls the composer makes (a recording fake in tests) */
export type Context2D = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'font'
  | 'textBaseline'
  | 'textAlign'
  | 'fillRect'
  | 'fillText'
  | 'measureText'
  | 'drawImage'
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'rect'
  | 'arc'
  | 'moveTo'
  | 'lineTo'
  | 'clip'
  | 'fill'
  | 'stroke'
>

/** What a <video> gives the composer */
export interface FrameSource {
  readonly videoWidth: number
  readonly videoHeight: number
  readonly readyState: number
}

/** Off-screen video elements for tracks (a fake in tests) */
export interface VideoFactory {
  /** A playing, muted, off-screen element for the track */
  open(track: MediaStreamTrack): FrameSource
  close(source: FrameSource): void
}

/** The browser's: a muted <video> that never joins the page */
export const browserVideos: VideoFactory = {
  open(track) {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.autoplay = true
    video.srcObject = new MediaStream([track])
    void video.play().catch(() => {})
    return video
  },
  close(source) {
    const video = source as HTMLVideoElement
    video.pause()
    video.srcObject = null
  },
}

/** HTMLMediaElement.HAVE_CURRENT_DATA: a frame to draw */
const HAVE_CURRENT_DATA = 2

export class Composer {
  private readonly ctx: Context2D
  private readonly width: number
  private readonly height: number
  private readonly videos: VideoFactory
  private readonly open = new Map<string, { track: MediaStreamTrack; source: FrameSource }>()

  constructor(ctx: Context2D, width: number, height: number, videos: VideoFactory = browserVideos) {
    this.ctx = ctx
    this.width = width
    this.height = height
    this.videos = videos
  }

  /** How many video elements are open (one per track drawn) */
  get openVideos(): number {
    return this.open.size
  }

  /** Draws one frame of the scene */
  draw(scene: Scene): void {
    const placements = placeScene(scene, this.width, this.height)
    this.syncVideos(placements)
    const { ctx } = this
    ctx.fillStyle = colors.bg
    ctx.fillRect(0, 0, this.width, this.height)
    for (const placement of placements) {
      if (placement.kind === 'share') this.drawShare(placement)
      else this.drawTile(placement)
    }
  }

  dispose(): void {
    for (const { source } of this.open.values()) this.videos.close(source)
    this.open.clear()
  }

  /** One video element per track on screen: new ones opened, gone ones closed */
  private syncVideos(placements: Placement[]): void {
    const wanted = new Map<string, MediaStreamTrack>()
    for (const placement of placements) {
      const track = placement.kind === 'share' ? placement.share.video : placement.tile.video
      if (track && track.readyState !== 'ended') wanted.set(track.id, track)
    }
    for (const [id, entry] of this.open) {
      if (wanted.get(id) === entry.track) continue
      this.videos.close(entry.source)
      this.open.delete(id)
    }
    for (const [id, track] of wanted) {
      if (!this.open.has(id)) this.open.set(id, { track, source: this.videos.open(track) })
    }
  }

  private frame(track: MediaStreamTrack | null): FrameSource | null {
    if (!track) return null
    const source = this.open.get(track.id)?.source
    return source && source.readyState >= HAVE_CURRENT_DATA && source.videoWidth > 0 ? source : null
  }

  private scale(): number {
    return this.height / 720
  }

  private drawShare(placement: Extract<Placement, { kind: 'share' }>): void {
    const { ctx } = this
    const { rect, share } = placement
    ctx.fillStyle = colors.tileTo
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
    const source = this.frame(share.video)
    if (source) {
      this.drawVideo(source, rect, 'contain')
      this.drawMarks(source, rect, share)
    }
    this.nameplate(rect, strings.record.shareLabel(share.name), false)
  }

  /** The marks on the share (J2), on the picture where the video went (`contain`) */
  private drawMarks(source: FrameSource, rect: Rect, share: SceneShare): void {
    const strokes = share.marks?.() ?? []
    const fitted = fitVideo(source.videoWidth, source.videoHeight, rect, 'contain')
    if (strokes.length === 0 || !fitted) return
    const { ctx } = this
    const { x, y, width, height } = fitted.target
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, width, height)
    ctx.clip()
    // A real context whenever there are marks: the tests' fake draws no shares with any
    const canvas = ctx as CanvasRenderingContext2D
    for (const stroke of strokes) drawStroke(canvas, stroke, fitted.target, 1)
    ctx.restore()
  }

  private drawTile(placement: Extract<Placement, { kind: 'tile' }>): void {
    const { ctx } = this
    const { rect, tile } = placement
    const radius = Math.min(12 * this.scale(), rect.width / 8)
    ctx.save()
    roundedPath(ctx, rect, radius)
    ctx.clip()
    ctx.fillStyle = colors.tileFrom
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
    const source = this.frame(tile.video)
    if (source) this.drawVideo(source, rect, 'cover')
    else this.initial(rect, tile.name)
    ctx.restore()
    this.nameplate(rect, tile.name, tile.micMuted)
  }

  private drawVideo(source: FrameSource, rect: Rect, fit: 'cover' | 'contain'): void {
    const fitted = fitVideo(source.videoWidth, source.videoHeight, rect, fit)
    if (!fitted) return
    const { source: from, target: to } = fitted
    try {
      this.ctx.drawImage(
        source as unknown as CanvasImageSource,
        from.x,
        from.y,
        from.width,
        from.height,
        to.x,
        to.y,
        to.width,
        to.height,
      )
    } catch {
      // A frame that went away between the check and the draw: the tile's colour shows instead
    }
  }

  /** A camera-off tile: the initial on the member's colour (as the tiles show it) */
  private initial(rect: Rect, name: string): void {
    const { ctx } = this
    const size = Math.min(rect.width, rect.height) * 0.36
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    ctx.fillStyle = avatarColor(name)
    ctx.beginPath()
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = avatar.text
    ctx.font = `700 ${Math.round(size * 0.45)}px ${font.ui}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText([...name][0]?.toUpperCase() ?? '', cx, cy)
  }

  /** The name at the bottom left, on the overlay colour; a red muted mark before it */
  private nameplate(rect: Rect, name: string, muted: boolean): void {
    const { ctx } = this
    const s = this.scale()
    const size = Math.max(10, Math.round(13 * s))
    const pad = Math.round(8 * s)
    const height = size + pad
    const markSize = muted ? size : 0
    const markGap = muted ? Math.round(6 * s) : 0
    ctx.font = `600 ${size}px ${font.ui}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const maxText = Math.max(0, rect.width - 2 * pad - markSize - markGap - 2 * pad)
    const text = fitText(ctx, name, maxText)
    const width = Math.min(
      rect.width - 2 * pad,
      ctx.measureText(text).width + 2 * pad + markSize + markGap,
    )
    if (width <= 0) return
    const x = rect.x + pad
    const y = rect.y + rect.height - pad - height
    ctx.save()
    ctx.fillStyle = colors.overlay
    roundedPath(ctx, { x, y, width, height }, Math.round(8 * s))
    ctx.fill()
    if (muted) {
      // A red disc with a slash: the microphone is off (also in words for the people in the call)
      const cx = x + pad + markSize / 2
      const cy = y + height / 2
      ctx.fillStyle = colors.danger
      ctx.beginPath()
      ctx.arc(cx, cy, markSize / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = colors.onDanger
      ctx.lineWidth = Math.max(1.5, 2 * s)
      ctx.beginPath()
      ctx.moveTo(cx - markSize / 4, cy - markSize / 4)
      ctx.lineTo(cx + markSize / 4, cy + markSize / 4)
      ctx.stroke()
    }
    ctx.fillStyle = colors.fg
    ctx.fillText(text, x + pad + markSize + markGap, y + height / 2)
    ctx.restore()
  }
}

/** A rounded rectangle's path (arcs, so it works where roundRect does not) */
function roundedPath(ctx: Context2D, rect: Rect, radius: number): void {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2))
  const { x, y, width: w, height: h } = rect
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0)
  ctx.lineTo(x + w, y + h - r)
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2)
  ctx.lineTo(x + r, y + h)
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI)
  ctx.lineTo(x, y + r)
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5)
}

/** The name, cut with … to fit `max` pixels */
function fitText(ctx: Context2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  const chars = [...text]
  while (chars.length > 0 && ctx.measureText(`${chars.join('')}…`).width > max) chars.pop()
  return chars.length > 0 ? `${chars.join('')}…` : ''
}
