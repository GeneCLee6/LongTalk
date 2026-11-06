// Stand-ins for the uploads tests (I5): an R2 bucket in memory that behaves like the binding where
// it matters (a stream must have a known length, a put is all or nothing, a list pages), and the
// runtime's FixedLengthStream (fails the moment one byte too many goes through, and when too few
// did at the end).

export type StoredObject = {
  bytes: Uint8Array
  contentType?: string
}

export class FakeBucket {
  readonly objects = new Map<string, StoredObject>()
  /** How many operations of each kind ran, to keep an eye on the free quota */
  readonly calls = { put: 0, get: 0, list: 0, delete: 0 }
  pageSize = 1000

  async put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ) {
    this.calls.put += 1
    let bytes: Uint8Array
    if (value instanceof ReadableStream) {
      const chunks: Uint8Array[] = []
      const reader = value.getReader()
      for (;;) {
        const { value: chunk, done } = await reader.read()
        if (done) break
        chunks.push(chunk)
      }
      bytes = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0))
      let at = 0
      for (const chunk of chunks) {
        bytes.set(chunk, at)
        at += chunk.byteLength
      }
    } else {
      bytes = new Uint8Array(value as ArrayBuffer)
    }
    // Reached only when the whole stream was read: a failed stream stores nothing
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType })
    return { key, size: bytes.byteLength }
  }

  async get(key: string) {
    this.calls.get += 1
    const object = this.objects.get(key)
    if (!object) return null
    return {
      size: object.bytes.byteLength,
      body: new Response(object.bytes as unknown as ArrayBuffer).body,
      text: async () => new TextDecoder().decode(object.bytes),
      httpMetadata: { contentType: object.contentType },
    }
  }

  async head(key: string) {
    const object = this.objects.get(key)
    return object ? { size: object.bytes.byteLength } : null
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    this.calls.list += 1
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ''))
      .sort()
    // Like R2's, the cursor is a place in the key order: deleting behind it skips nothing
    const rest = options.cursor ? keys.filter((key) => key > options.cursor!) : keys
    const limit = Math.min(options.limit ?? this.pageSize, this.pageSize)
    const page = rest.slice(0, limit)
    const truncated = rest.length > limit
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.bytes.byteLength })),
      truncated,
      cursor: truncated ? page.at(-1) : undefined,
    }
  }

  async delete(keys: string | string[]) {
    this.calls.delete += 1
    for (const key of [keys].flat()) this.objects.delete(key)
  }
}

export const asBucket = (bucket: FakeBucket) => bucket as unknown as R2Bucket

/** FixedLengthStream's behaviour, for Node */
export function fakeFixedLength(bytes: number) {
  let written = 0
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength
      if (written > bytes) {
        throw new TypeError('Attempt to write too many bytes through a FixedLengthStream')
      }
      controller.enqueue(chunk)
    },
    flush() {
      if (written < bytes) {
        throw new TypeError('FixedLengthStream did not see all expected bytes before close()')
      }
    },
  })
}

/** A PNG's first bytes, then padding */
export function png(size = 64): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

/** A body that sends `chunks` and counts how many were asked for */
export function chunkedBody(chunks: readonly Uint8Array[]) {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks.length) controller.close()
      else controller.enqueue(chunks[sent++])
    },
  })
  return { stream, sent: () => sent }
}
