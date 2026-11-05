import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ChatFile } from '../../shared/files.ts'
import { fetchFile, filesApi } from '../api/files.ts'
import { FileUploads, type UploadItem } from './fileUploads.ts'
import { makeThumbnail } from './thumbnail.ts'

/** What the chat panel gets to share and open files (I5, e5-t05, e5-t06) */
export interface FileSharing {
  uploads: readonly UploadItem[]
  pick(files: readonly File[]): void
  cancel(key: number): void
  retry(key: number): void
  dismiss(key: number): void
  /** A file's bytes; thumbnails are kept while the room is open, so scrolling costs nothing */
  load(file: ChatFile, thumb: boolean): Promise<Blob>
  /** Fetches the file and hands it to the browser as a download */
  download(file: ChatFile): Promise<void>
}

/**
 * Hands bytes to the browser as a download. The object URL is ours (`blob:` on this origin), so it
 * is only ever used with `download`, which saves it and never opens it.
 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  // Safari reads the URL a little after the click
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function useFileSharing(roomId: string, token: string | null): FileSharing {
  const latestToken = useRef(token)
  useEffect(() => {
    latestToken.current = token
  }, [token])
  const uploader = useMemo(
    () => new FileUploads(filesApi(roomId, () => latestToken.current), makeThumbnail),
    [roomId],
  )
  useEffect(() => () => uploader.stop(), [uploader])
  const uploads = useSyncExternalStore(uploader.subscribe, uploader.items)
  const thumbs = useRef(new Map<string, Promise<Blob>>())

  const load = useCallback(
    (file: ChatFile, thumb: boolean): Promise<Blob> => {
      if (!thumb) return fetchFile(roomId, file, false, latestToken.current)
      const known = thumbs.current.get(file.id)
      if (known) return known
      const loading = fetchFile(roomId, file, true, latestToken.current)
      thumbs.current.set(file.id, loading)
      loading.catch(() => thumbs.current.delete(file.id))
      return loading
    },
    [roomId],
  )

  const download = useCallback(
    async (file: ChatFile) => saveBlob(await load(file, false), file.name),
    [load],
  )

  return useMemo(
    () => ({
      uploads,
      pick: (files: readonly File[]) => uploader.add(files),
      cancel: (key: number) => uploader.cancel(key),
      retry: (key: number) => uploader.retry(key),
      dismiss: (key: number) => uploader.dismiss(key),
      load,
      download,
    }),
    [uploads, uploader, load, download],
  )
}
