import { BOARD_PREFIX, UPLOAD_PREFIX, uploadExpired } from '../shared/files.ts'
import { parseBoardKey } from './board-store.ts'

// The hourly sweep of the upload bucket (I5, e11-t08). The whole prefix is listed: expired keys
// are deleted, the rest is what the bucket really holds, which goes to FileLedgerDO. The key says
// the hour (shared/files.ts), so nothing else needs reading. Listing is a few Class A operations
// (1,000 keys each); R2 does not charge for deleting.
//
// Persistent rooms' whiteboards (J4, e7-t08) are in the same bucket at another prefix: the 24 hours
// do not apply, but they count, so they go in `live`. The one way one is deleted here is when its
// room no longer exists (`roomsExist`): deleting the room deletes its board, and this is what keeps
// that true if the deletion failed that once. Without a way to ask, nothing is deleted.

export type SweepResult = {
  live: { bytes: number; objects: number }
  deleted: { bytes: number; objects: number }
}

/** R2's limit for one delete call and one list page */
const PAGE = 1000

/** Which of these keys are of a room that still exists, as they say: the same slug, made then */
export type RoomsExist = (rooms: { key: string; slug: string; createdAt: number }[]) => Promise<Set<string>>

async function sweepBoards(
  bucket: Pick<R2Bucket, 'list' | 'delete'>,
  roomsExist: RoomsExist | undefined,
  result: SweepResult,
): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: BOARD_PREFIX, limit: PAGE, cursor })
    const rooms = page.objects.flatMap(({ key }) => {
      const room = parseBoardKey(key)
      return room ? [{ key, ...room }] : []
    })
    // A failure here fails the run, and nothing was deleted on a guess
    const existing = roomsExist && rooms.length > 0 ? await roomsExist(rooms) : null
    const orphans: string[] = []
    for (const object of page.objects) {
      if (existing && !existing.has(object.key)) {
        orphans.push(object.key)
        result.deleted.objects += 1
        result.deleted.bytes += object.size
      } else {
        result.live.objects += 1
        result.live.bytes += object.size
      }
    }
    if (orphans.length > 0) await bucket.delete(orphans)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

export async function sweepUploads(
  bucket: Pick<R2Bucket, 'list' | 'delete'>,
  now: number,
  roomsExist?: RoomsExist,
): Promise<SweepResult> {
  const result: SweepResult = {
    live: { bytes: 0, objects: 0 },
    deleted: { bytes: 0, objects: 0 },
  }
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: UPLOAD_PREFIX, limit: PAGE, cursor })
    const expired: string[] = []
    for (const object of page.objects) {
      if (uploadExpired(object.key, now)) {
        expired.push(object.key)
        result.deleted.objects += 1
        result.deleted.bytes += object.size
      } else {
        result.live.objects += 1
        result.live.bytes += object.size
      }
    }
    if (expired.length > 0) await bucket.delete(expired)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  await sweepBoards(bucket, roomsExist, result)
  return result
}
