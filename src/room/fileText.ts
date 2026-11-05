import { MAX_FILE_BYTES, fileExtension, type ChatFile } from '../../shared/files.ts'
import { strings } from '../strings.ts'
import { formatBytes } from './chatText.ts'
import type { UploadItem } from './fileUploads.ts'

// The words for files in the chat (I5, e5-t05): what type a card says, why an upload stopped.

/** A file's type as a card says it: `PDF`, `PNG`, or 「檔案」 */
export function fileTypeLabel(file: Pick<ChatFile, 'name' | 'mime' | 'kind'>): string {
  if (file.kind === 'image') return file.mime.replace('image/', '').toUpperCase()
  const extension = fileExtension(file.name)
  return extension && extension.length <= 8 ? extension.toUpperCase() : strings.chat.file.generic
}

/** What went wrong with an upload, in words */
export function uploadProblemText(item: Pick<UploadItem, 'problem' | 'retryAfter'>): string {
  const text = strings.chat.file.problems
  switch (item.problem) {
    case 'too_large':
      return text.tooLarge(formatBytes(MAX_FILE_BYTES))
    case 'empty':
      return text.empty
    case 'blocked_type':
      return text.blockedType
    case 'not_an_image':
      return text.notAnImage
    case 'member_quota':
      return text.memberQuota
    case 'room_quota':
      return text.roomQuota
    case 'rate_limited':
      return text.rateLimited(Math.max(1, Math.ceil((item.retryAfter ?? 60) / 60)))
    case 'storage_full':
      return text.storageFull
    case 'unauthorized':
    case 'forbidden':
      return text.forbidden
    case 'blocked':
      return text.blocked
    case 'network':
    case 'incomplete':
      return text.network
    case 'stalled':
      return text.stalled
    default:
      return text.unavailable
  }
}
