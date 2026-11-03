// The browser's own microphone processing (e6-t01, AC-6.1): noise suppression, echo cancellation
// and automatic gain control, the three getUserMedia constraints. All three are on by default
// (what every browser does without being asked); the settings panel turns each off and on.
//
// Changing them in a call: `applyProcessing` asks the live track (applyConstraints) and then
// reads back what the browser really did (getSettings). Some browsers accept the call and change
// nothing (Chrome has long kept a microphone's processing as it was opened); then the caller
// opens the microphone again with the new constraints and swaps the sent track
// (LocalDevices.setProcessing → RoomMedia → MediaTransport.replaceTrack: no renegotiation).
// No React and no interface text here.

export type ProcessingKey = 'noiseSuppression' | 'echoCancellation' | 'autoGainControl'

/** In the settings panel's order */
export const PROCESSING_KEYS: readonly ProcessingKey[] = [
  'noiseSuppression',
  'echoCancellation',
  'autoGainControl',
]

export type AudioProcessing = Record<ProcessingKey, boolean>

export const DEFAULT_PROCESSING: AudioProcessing = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
}

export const isDefaultProcessing = (processing: AudioProcessing): boolean =>
  PROCESSING_KEYS.every((key) => processing[key] === DEFAULT_PROCESSING[key])

/**
 * What getUserMedia is asked for on top of the device: only the switches turned off. The
 * browsers' defaults are all on, so a microphone with every switch on is asked for exactly as
 * before (no new constraint that a browser could reject).
 */
export function processingConstraints(processing: AudioProcessing): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {}
  for (const key of PROCESSING_KEYS) {
    if (processing[key] !== DEFAULT_PROCESSING[key]) constraints[key] = processing[key]
  }
  return constraints
}

/** The bits of MediaStreamTrack applyProcessing uses, so tests can pass a fake */
export interface ProcessingTrack {
  applyConstraints?(constraints: MediaTrackConstraints): Promise<void>
  getConstraints?(): MediaTrackConstraints
  getSettings?(): MediaTrackSettings
}

/**
 * Changes a live microphone's processing. Resolves true when the browser did it (or cannot say:
 * no setting reported), false when it refused or kept the old values: open the microphone again
 * then. The track's other constraints (its device) are kept: applyConstraints replaces them all.
 */
export async function applyProcessing(
  track: ProcessingTrack,
  processing: AudioProcessing,
): Promise<boolean> {
  if (typeof track.applyConstraints !== 'function') return false
  try {
    await track.applyConstraints({ ...(track.getConstraints?.() ?? {}), ...processing })
  } catch {
    return false
  }
  const settings = (track.getSettings?.() ?? {}) as Partial<Record<ProcessingKey, unknown>>
  return PROCESSING_KEYS.every(
    (key) => typeof settings[key] !== 'boolean' || settings[key] === processing[key],
  )
}
