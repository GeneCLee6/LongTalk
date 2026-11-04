import { useEffect, useState } from 'react'
import styled from 'styled-components'
import { recordingPending } from '../record/pending.ts'
import type { RecordingMeta, RecordingStore } from '../record/store.ts'
import { formatDateTime, strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'

export interface RecordingRecoveryProps {
  /** Said once the leftover was downloaded or deleted (a toast) */
  onDone?: (text: string) => void
}

type Found = { meta: RecordingMeta; store: RecordingStore }

/**
 * 「下載上次未完成的錄影」 (I4, e8-t01): a local recording whose tab closed or crashed before it
 * was saved is still in IndexedDB, chunk by chunk; this offers it once on the next visit (the
 * home page, the room), with 刪除. Loads the store only when the pending flag says there may be
 * one (src/record/pending.ts): nothing for everyone who never recorded.
 */
export function RecordingRecovery({ onDone }: RecordingRecoveryProps) {
  const [found, setFound] = useState<Found | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!recordingPending()) return
    let cancelled = false
    void import('../record/store.ts')
      .then(async (module) => {
        const store = await module.openRecordingStore()
        await store.cleanUp()
        const [meta] = await store.leftovers(await module.heldRecordings())
        if (!cancelled && meta) setFound({ meta, store })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  if (!found) return null
  const settle = (text: string) => {
    setFound(null)
    setBusy(false)
    onDone?.(text)
  }
  const download = () => {
    setBusy(true)
    void import('../record/store.ts')
      .then((module) => module.downloadLeftover(found.store, found.meta))
      .then(
        () => settle(strings.record.leftoverDownloaded),
        () => setBusy(false),
      )
  }
  const remove = () => {
    setBusy(true)
    void found.store.remove(found.meta.id).then(
      () => settle(strings.record.leftoverDeleted),
      () => setBusy(false),
    )
  }
  return (
    <Offer role="status">
      <span>{strings.record.leftover(formatDateTime(found.meta.startedAt))}</span>
      <Actions>
        <TextButton type="button" disabled={busy} onClick={download}>
          {strings.record.leftoverDownload}
        </TextButton>
        <TextButton type="button" disabled={busy} onClick={remove}>
          {strings.record.leftoverDelete}
        </TextButton>
      </Actions>
    </Offer>
  )
}

const Offer = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${space(1)} ${space(3)};
  max-width: 640px;
  padding: ${space(2)} ${space(3)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface};
  color: ${color.fg};
  font-size: ${fontSize.small};
`

const Actions = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  gap: ${space(3)};
`

const TextButton = styled.button`
  padding: 0;
  border: none;
  background: none;
  color: ${color.primary};
  font: inherit;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
`
