import type { SignalLevel } from '../../shared/protocol.ts'
import type { zhTWHome } from './zh-TW.home.ts'
import type { zhTWRoom } from './zh-TW.ts'

/**
 * The Chinese dictionary's shape with its literal texts widened to `string`: every dictionary is
 * one of these. Functions keep their parameters (their results widen too); keys stay exact, so a
 * missing or extra key in another dictionary is a type error.
 */
export type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : T extends object
        ? { readonly [K in keyof T]: Widen<T[K]> }
        : T

/** What the home page reads, in its first load (J4): zh-TW.home.ts, en.home.ts */
export type HomeStrings = Widen<typeof zhTWHome>
/** The rest, a chunk per language loaded with the lazy pages (J4): zh-TW.ts, en.ts */
export type RoomStrings = Widen<typeof zhTWRoom>
/** A whole dictionary */
export type Strings = HomeStrings & RoomStrings

/** What a tile says about its member besides the name (G5, e4-t14; `room.tileState`) */
export interface TileState {
  host: boolean
  cohost: boolean
  micMuted: boolean
  camOff: boolean
  /** Their place in the raised-hand queue, 1 first; null when the hand is down */
  hand: number | null
  pinned: boolean
  spotlighted: boolean
  reconnecting: boolean
  /** Their connection as they report it (H2, e2-t13); null or absent: unknown */
  signal?: SignalLevel | null
  /** Their camera is on but not received, to save our downlink (e2-t15) */
  videoPaused?: boolean
}
