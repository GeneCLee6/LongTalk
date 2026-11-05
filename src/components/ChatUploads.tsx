import styled from 'styled-components'
import { formatBytes } from '../room/chatText.ts'
import { uploadProblemText } from '../room/fileText.ts'
import type { UploadItem } from '../room/fileUploads.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { CloseIcon, RefreshIcon } from './icons.tsx'

export interface ChatUploadsProps {
  uploads: readonly UploadItem[]
  onCancel(key: number): void
  onRetry(key: number): void
  onDismiss(key: number): void
}

/** Refusals that another try cannot change */
const FINAL: ReadonlySet<string> = new Set(['too_large', 'empty', 'blocked_type', 'not_an_image'])

/**
 * The uploads under way, above the message box (I5, e5-t05): a progress bar and 「取消」 while the
 * bytes go out; when it fails, why, in words, with 「再試一次」 where that can help.
 */
export function ChatUploads({ uploads, onCancel, onRetry, onDismiss }: ChatUploadsProps) {
  return (
    <List aria-label={strings.chat.file.uploads}>
      {uploads.map((item) => (
        <Item key={item.key}>
          <Top>
            <Name>{item.name}</Name>
            {item.state === 'failed' && item.problem && !FINAL.has(item.problem) && (
              <Small
                type="button"
                aria-label={strings.chat.file.retry(item.name)}
                title={strings.chat.file.retry(item.name)}
                onClick={() => onRetry(item.key)}
              >
                <RefreshIcon />
              </Small>
            )}
            <Small
              type="button"
              aria-label={
                item.state === 'failed'
                  ? strings.chat.file.dismiss(item.name)
                  : strings.chat.file.cancel(item.name)
              }
              title={
                item.state === 'failed'
                  ? strings.chat.file.dismiss(item.name)
                  : strings.chat.file.cancel(item.name)
              }
              onClick={() =>
                item.state === 'failed' ? onDismiss(item.key) : onCancel(item.key)
              }
            >
              <CloseIcon />
            </Small>
          </Top>
          {item.state === 'failed' ? (
            <Problem role="alert">{uploadProblemText(item)}</Problem>
          ) : (
            <>
              <Bar
                role="progressbar"
                aria-label={strings.chat.file.uploading(item.name)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(item.progress * 100)}
              >
                <Fill style={{ width: `${Math.round(item.progress * 100)}%` }} />
              </Bar>
              <Details>
                {item.state === 'queued'
                  ? strings.chat.file.queued
                  : strings.chat.file.progress(
                      formatBytes(item.size * item.progress),
                      formatBytes(item.size),
                    )}
              </Details>
            </>
          )}
        </Item>
      ))}
    </List>
  )
}

const List = styled.ul`
  display: grid;
  gap: ${space(1)};
  margin: 0;
  padding: 0;
  list-style: none;
`

const Item = styled.li`
  display: grid;
  gap: ${space(1)};
  padding: ${space(1)} ${space(2)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface2};
  font-size: ${fontSize.toolbarLabel};
`

const Top = styled.div`
  display: flex;
  align-items: center;
  gap: ${space(1)};
  min-width: 0;
`

const Name = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${color.fg};
`

const Small = styled.button`
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: ${radius.button};
  background: transparent;
  color: ${color.muted};
  cursor: pointer;

  svg {
    width: 18px;
    height: 18px;
  }
  &:hover {
    color: ${color.fg};
  }
`

const Bar = styled.div`
  height: 6px;
  border-radius: ${radius.pill};
  background: ${color.line};
  overflow: hidden;
`

const Fill = styled.div`
  height: 100%;
  background: ${color.primary};
  transition: width 120ms linear;
`

const Details = styled.span`
  color: ${color.muted};
  font-variant-numeric: tabular-nums;
`

const Problem = styled.span`
  color: ${color.warn};
`
