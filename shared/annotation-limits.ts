// Every number that bounds annotations on a share and on the whiteboard (E7, J2: e7-t03, e7-t04;
// J3: e7-t06), in one place: the room enforces them (worker/room-annotations.ts, worker/room-host.ts), the browser stays inside them
// (src/annotate/sync.ts, src/room/annotationStore.ts).
//
// The budget they protect is Cloudflare's free tier (DEPLOY.md, ARCHITECTURE.md):
// - WebSocket messages into a Durable Object count 20:1 as requests (100,000 a day): one person
//   drawing without a pause for an hour is 36,000 frames, 1,800 requests;
// - storage writes (100,000 rows a day): nothing is written per point or per frame. Strokes are
//   kept in segments of about SEGMENT_CHARS and only the segments that changed are written, at
//   most every ANNOTATION_FLUSH_MS: about 720 rows for that hour.

/** A share keeps at most this many strokes, everyone's together; past it the oldest go */
export const MAX_STROKES = 2000
/**
 * One stroke's points after thinning: a whole stroke must fit one client frame
 * (ANNOTATION_FRAME_CHARS), each point being at most `[0.1234,0.5678],`
 */
export const MAX_STROKE_POINTS = 800
/** A text mark's length, characters (normalizeChatText's rules otherwise) */
export const MAX_ANNOTATION_TEXT_CHARS = 500
/** An id's length: a stroke id is made in the browser and read off the wire */
export const MAX_STROKE_ID_CHARS = 40

/** One member's strokes on one share; past it their own oldest go, so nobody crowds out the rest */
export const MAX_MEMBER_STROKES = 500
/** What one share may hold (strokeCost, about JSON characters): 3 shares fit a DO comfortably */
export const MAX_SHARE_COST = 1_500_000
/** What one member may hold on one share: a third, so one scribbler cannot push out the others */
export const MAX_MEMBER_COST = 500_000

/**
 * PRD E7: the browser sends what is new at most this often while drawing (the ops since the last
 * send go in one frame), so a stroke reaches the others well within AC-7.2's 300 ms.
 */
export const ANNOTATION_SEND_MS = 100
/** A client frame's length in the browser's budget: below MAX_CLIENT_MESSAGE_CHARS (16,384) */
export const ANNOTATION_FRAME_CHARS = 15_000
/** Ops in one client frame */
export const MAX_FRAME_OPS = 32
/**
 * Frames per member (the laser pointer's too), beyond which the room drops them. A browser keeping
 * ANNOTATION_SEND_MS sends at most 100 in 10 s. It must stay below SOCKET_MESSAGE_RATE, which
 * closes the socket: a test checks that.
 */
export const ANNOTATION_FRAME_RATE = { count: 110, windowMs: 10_000 } as const
/** New strokes per member: quick handwriting, not a script */
export const ANNOTATION_STROKE_RATE = { count: 60, windowMs: 10_000 } as const
/** Undo and redo reach back this far */
export const MAX_ANNOTATION_HISTORY = 100
/** What a browser keeps to send when the socket comes back, while it is away */
export const MAX_ANNOTATION_OUTBOX = 200

/** A snapshot frame's length, about: a joiner gets all of a share's strokes in frames like this */
export const SNAPSHOT_FRAME_CHARS = 64_000
/** A stored segment's length, about (a SQLite-backed DO allows 2 MB a value) */
export const SEGMENT_CHARS = 64_000
/** Changed segments are written at most this often; a share stopping writes at once */
export const ANNOTATION_FLUSH_MS = 5_000

// ---------------------------------------------------------------------------------------------
// The whiteboard (J3, e7-t06): one more layer in the same machinery, with its own numbers

/**
 * How far the board's world goes each way from its centre, in world units (1 unit is BOARD_UNIT_PX
 * on screen at 100%): about a million pixels, which no one pans to, and it keeps a point's length
 * on the wire bounded. "Infinite" for every purpose but that.
 */
export const BOARD_EXTENT = 1000
/**
 * One stroke's points on the board. A point there can be `[-999.1234,-999.1234],`, longer than on a
 * share, and a whole stroke must still fit one client frame (a test checks it does)
 */
export const MAX_BOARD_STROKE_POINTS = 600
/** The board keeps at most this many strokes, everyone's together */
export const MAX_BOARD_STROKES = 4000
/** What the board may hold (strokeCost): twice a share, since it stays until someone clears it */
export const MAX_BOARD_COST = 3_000_000
/** What one member may hold on the board: nobody fills it alone */
export const MAX_BOARD_MEMBER_STROKES = 1500
export const MAX_BOARD_MEMBER_COST = 1_000_000

/**
 * What a layer may hold, and what happens past it. A share's oldest strokes fall out (J2: it is
 * cleared when the share stops anyway). A board is what people came to keep: nothing of it
 * disappears by itself, a new stroke is refused and the member told to clear some.
 */
export type LayerLimits = {
  strokes: number
  cost: number
  memberStrokes: number
  memberCost: number
  whenFull: 'evict' | 'refuse'
}

export const SHARE_LIMITS: LayerLimits = {
  strokes: MAX_STROKES,
  cost: MAX_SHARE_COST,
  memberStrokes: MAX_MEMBER_STROKES,
  memberCost: MAX_MEMBER_COST,
  whenFull: 'evict',
}

export const BOARD_LIMITS: LayerLimits = {
  strokes: MAX_BOARD_STROKES,
  cost: MAX_BOARD_COST,
  memberStrokes: MAX_BOARD_MEMBER_STROKES,
  memberCost: MAX_BOARD_MEMBER_COST,
  whenFull: 'refuse',
}

/**
 * A persistent room's board in R2 (J4, e7-t08): a meeting that changed it saves at most this often,
 * on top of when the last person leaves and when the meeting closes. 12 Class A operations an hour
 * for a room being drawn in, of a free million a month; what a crash can lose is at most this.
 */
export const BOARD_SAVE_MS = 5 * 60_000
/**
 * The saved JSON's largest size, bytes. A board within its limits is below it even when every point
 * is as long as a point can be (cost counts 16 characters a point, the longest takes 21) and all its
 * text is three-byte characters: a test fills one to check that. So only a bug ever hits this.
 */
export const MAX_BOARD_FILE_BYTES = 5 * 1024 * 1024

/** PRD E7: the laser pointer lasts this long after its last position, fading out */
export const LASER_FADE_MS = 3_000
/** A stroke not heard of for this long no longer counts as being drawn (its name tag goes) */
export const ACTIVE_STROKE_MS = 1_500
