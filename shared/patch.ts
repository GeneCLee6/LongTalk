// Diff push (ARCHITECTURE.md §2): the RoomDO keeps the last view it sent and sends only what
// changed. `diff` and `applyPatch` are the two halves; the server diffs, the browser applies.
// Objects are diffed key by key; arrays and other values are replaced whole.

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export type PatchOp =
  /** Sets the value at `path`; the empty path replaces the whole state */
  { op: 'set'; path: string[]; value: JsonValue } | { op: 'del'; path: string[] }

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]))
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && jsonEqual(a[key], b[key]))
    )
  }
  return false
}

/** The operations that turn `before` into `after`; empty when nothing changed */
export function diff(before: JsonValue, after: JsonValue, path: string[] = []): PatchOp[] {
  if (!isObject(before) || !isObject(after)) {
    return jsonEqual(before, after) ? [] : [{ op: 'set', path, value: after }]
  }
  const ops: PatchOp[] = []
  for (const key of Object.keys(before)) {
    if (!(key in after)) ops.push({ op: 'del', path: [...path, key] })
  }
  for (const [key, value] of Object.entries(after)) {
    if (key in before) ops.push(...diff(before[key], value, [...path, key]))
    else ops.push({ op: 'set', path: [...path, key], value })
  }
  return ops
}

/**
 * Applies the operations without changing `state`: the objects along each changed path are
 * copied, everything else is shared (so React sees exactly what changed).
 */
export function applyPatch<T extends JsonValue>(state: T, ops: readonly PatchOp[]): T {
  let next: JsonValue = state
  for (const op of ops) next = applyOne(next, op.path, op)
  return next as T
}

function applyOne(node: JsonValue | undefined, path: readonly string[], op: PatchOp): JsonValue {
  if (path.length === 0) {
    if (op.op === 'set') return op.value
    throw new Error('Cannot delete the root')
  }
  const [key, ...rest] = path
  // Keys come from the server's own state, but a patch must never reach an object's prototype
  if (key === '__proto__') throw new Error('Invalid patch path')
  const copy: JsonObject = isObject(node) ? { ...node } : {}
  if (rest.length === 0 && op.op === 'del') {
    delete copy[key]
  } else {
    copy[key] = applyOne(copy[key], rest, op)
  }
  return copy
}
