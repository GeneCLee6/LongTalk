/**
 * Fake cameras and microphones, without a permission prompt, for the browsers Playwright drives
 * (both configs; H6, e2-t16).
 *
 * - Chromium: command-line switches (a moving pie and a beep, unless a file is given).
 * - Firefox: prefs; Playwright cannot grant camera or microphone in Firefox, so the prompt is
 *   turned off instead. The fake camera is a changing colour, the microphone a steady tone.
 * - WebKit: Playwright grants `camera` and `microphone`; whether its build has capture devices at
 *   all depends on the platform (none on Windows, which has no WebRTC there).
 */
export const chromiumFakeMedia = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]

export const firefoxFakeMedia = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
  // Sound plays without a click first, as with Chromium's autoplay switch
  'media.autoplay.default': 0,
  'media.autoplay.block-webaudio': false,
}
