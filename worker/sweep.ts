import { UPLOAD_PREFIX, uploadExpired } from '../shared/files.ts'

// The hourly sweep of the upload bucket (I5, e11-t08). The whole prefix is listed: expired keys
// are deleted, the rest is what the bucket really holds, which goes to FileLedgerDO. The key says
// the hour (shared/files.ts), so nothing else needs reading. Listing is a few Class A operations
// (1,000 keys each); R2 does not charge for deleting.

export type SweepResult = {
  live: { bytes: number; objects: number }
  deleted: { bytes: number; objects: number }
}

/** R2's limit for one delete call and one list page */
const PAGE = 1000

export async function sweepUploads(
  bucket: Pick<R2Bucket, 'list' | 'delete'>,
  now: number,
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
  return result
}
