import { MAX_DEVICE_CHARS, normalizeLabel } from '../../../shared/control.ts'

/** The device name to suggest: the computer's name (from Rust), cut to what the room keeps */
export function defaultDevice(hostname: string): string {
  return normalizeLabel([...hostname].slice(0, MAX_DEVICE_CHARS).join('')) ?? ''
}
