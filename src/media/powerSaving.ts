// 省電模式 (e6-t05, AC-6.4): what it changes, in one place. RoomMedia applies the media side, the
// room page the rest (useRoomMedia's `powerSaving`, RoomPage):
//
// - Every received camera and screen at its lowest layer (the camera's 180p at 15 fps, the
//   screen's half size at 15 fps): RoomMedia chooses layers within a budget of
//   POWER_SAVING_BUDGET_BPS, and layers.ts steps everything down to its floor (cameras first,
//   then the screen). Less to decode is most of the saving.
// - Our camera never sends HD (its 720p layer is off, like HD off: MediaTransport.setTopLayer)
//   and is captured at POWER_SAVING_FPS (applyConstraints on the camera: less to capture and
//   encode); turning the mode off asks for the normal rate again.
// - No animation in the room: reactions do not float, drawers do not slide, pages jump (the
//   reduced-motion paths, as if the system asked for it).
// - The advanced noise suppression is off while it is on (the setting itself is kept).
// No React and no interface text here.

/** The video budget while saving power: nothing above each video's lowest layer fits */
export const POWER_SAVING_BUDGET_BPS = 0
/** The camera's capture frame rate while saving power */
export const POWER_SAVING_FPS = 15

/** The bits of MediaStreamTrack capFrameRate uses */
export interface FrameRateTrack {
  applyConstraints(constraints: MediaTrackConstraints): Promise<void>
  getConstraints?(): MediaTrackConstraints
}

/**
 * Caps the camera's capture at `fps`, or (null) lets it go back to its normal rate. Its other
 * constraints (device, size, a low-quality month's) are kept: applyConstraints replaces them
 * all. A camera that refuses keeps what it does; resolves false then.
 */
export async function capFrameRate(track: FrameRateTrack, fps: number | null): Promise<boolean> {
  const constraints: MediaTrackConstraints = { ...(track.getConstraints?.() ?? {}) }
  if (fps === null) delete constraints.frameRate
  else constraints.frameRate = { max: fps }
  try {
    await track.applyConstraints(constraints)
    return true
  } catch {
    return false
  }
}
