// MediaRecorder writes WebM as a live stream: the Segment's Info has no Duration, so players
// show no length and cannot seek (I4, e8-t01). When a recording stops we know how long it ran:
// this adds the Duration element to Info in the file's first chunk (where the header is) and
// leaves every other byte as it was. EBML (Matroska's binary format): every element is an ID, a
// size (both variable-length integers, "vints") and its data.

const EBML_ID = 0x1a45dfa3
const SEGMENT_ID = 0x18538067
const INFO_ID = 0x1549a966
const DURATION_ID = 0x4489
const TIMESTAMP_SCALE_ID = 0x2ad7b1
/** Matroska's default: one tick is a millisecond */
const DEFAULT_SCALE_NS = 1_000_000

interface Vint {
  value: number
  length: number
  /** Every value bit set: the size is unknown (a live stream's Segment) */
  unknown: boolean
}

/** A variable-length integer at `at`: the leading zeros of the first byte say how long it is */
function readVint(bytes: Uint8Array, at: number, keepMarker: boolean): Vint | null {
  const first = bytes[at]
  if (first === undefined || first === 0) return null
  const length = Math.clz32(first) - 23
  if (length > 8 || at + length > bytes.length) return null
  let value = keepMarker ? first : first & (0xff >> length)
  let ones = (first & (0xff >> length)) === 0xff >> length
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i]
    if (bytes[at + i] !== 0xff) ones = false
  }
  return { value, length, unknown: !keepMarker && ones }
}

/** A size as a vint of exactly `length` bytes */
function writeSize(value: number, length: number): Uint8Array | null {
  if (value >= 2 ** (7 * length) - 1) return null
  const out = new Uint8Array(length)
  let rest = value
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256
    rest = Math.floor(rest / 256)
  }
  out[0] |= 0x80 >> (length - 1)
  return out
}

/** The smallest vint for a size */
function sizeVint(value: number): Uint8Array {
  for (let length = 1; length <= 8; length++) {
    const out = writeSize(value, length)
    if (out) return out
  }
  throw new RangeError('size too large')
}

interface Element {
  id: number
  /** Where the element starts, its data starts and ends */
  start: number
  dataStart: number
  end: number
  sizeLength: number
  unknown: boolean
}

function readElement(bytes: Uint8Array, at: number): Element | null {
  const id = readVint(bytes, at, true)
  if (!id) return null
  const size = readVint(bytes, at + id.length, false)
  if (!size) return null
  const dataStart = at + id.length + size.length
  return {
    id: id.value,
    start: at,
    dataStart,
    end: size.unknown ? bytes.length : dataStart + size.value,
    sizeLength: size.length,
    unknown: size.unknown,
  }
}

function readUint(bytes: Uint8Array, from: number, to: number): number {
  let value = 0
  for (let i = from; i < to; i++) value = value * 256 + bytes[i]
  return value
}

/**
 * The first chunk with Info's Duration set to `durationMs`, or null when it does not look like
 * the start of a WebM file or already has a Duration (then use it as it is).
 */
export function withDuration(chunk: Uint8Array, durationMs: number): Uint8Array | null {
  const header = readElement(chunk, 0)
  if (!header || header.id !== EBML_ID || header.unknown) return null
  const segment = readElement(chunk, header.end)
  if (!segment || segment.id !== SEGMENT_ID) return null
  // Info is one of the Segment's first children (after SeekHead or Void, before Clusters)
  let at = segment.dataStart
  let info: Element | null = null
  for (let i = 0; i < 8 && at < chunk.length; i++) {
    const child = readElement(chunk, at)
    if (!child || child.unknown || child.end > chunk.length) return null
    if (child.id === INFO_ID) {
      info = child
      break
    }
    at = child.end
  }
  if (!info) return null
  let scale = DEFAULT_SCALE_NS
  for (let at = info.dataStart; at < info.end;) {
    const child = readElement(chunk, at)
    if (!child || child.end > info.end) return null
    if (child.id === DURATION_ID) return null
    if (child.id === TIMESTAMP_SCALE_ID)
      scale = readUint(chunk, child.dataStart, child.end) || scale
    at = child.end
  }
  // Duration: a float in ticks of the timestamp scale
  const duration = new Uint8Array(11)
  duration.set([0x44, 0x89, 0x88])
  new DataView(duration.buffer).setFloat64(3, (durationMs * 1_000_000) / scale)
  const infoData = info.end - info.dataStart + duration.length
  const infoSize = sizeVint(infoData)
  const infoId = chunk.subarray(info.start, info.dataStart - info.sizeLength)
  const grown = infoId.length + infoSize.length + infoData - (info.end - info.start)
  // A Segment of known size grows by as much (MediaRecorder's is unknown)
  let segmentSize: Uint8Array | null = null
  if (!segment.unknown) {
    segmentSize = writeSize(segment.end - segment.dataStart + grown, segment.sizeLength)
    if (!segmentSize) return null
  }
  const out = new Uint8Array(chunk.length + grown)
  let write = 0
  const put = (part: Uint8Array) => {
    out.set(part, write)
    write += part.length
  }
  if (segmentSize) {
    put(chunk.subarray(0, segment.dataStart - segment.sizeLength))
    put(segmentSize)
    put(chunk.subarray(segment.dataStart, info.start))
  } else {
    put(chunk.subarray(0, info.start))
  }
  put(infoId)
  put(infoSize)
  put(chunk.subarray(info.dataStart, info.end))
  put(duration)
  put(chunk.subarray(info.end))
  return out
}

/** The file's chunks with the first one given its Duration (WebM only; others as they are) */
export async function fixDuration(
  chunks: Blob[],
  mimeType: string,
  durationMs: number,
): Promise<Blob[]> {
  if (!mimeType.includes('webm') || chunks.length === 0 || !(durationMs > 0)) return chunks
  try {
    const first = new Uint8Array(await chunks[0].arrayBuffer())
    const fixed = withDuration(first, durationMs)
    return fixed ? [new Blob([fixed as BlobPart]), ...chunks.slice(1)] : chunks
  } catch {
    return chunks
  }
}
