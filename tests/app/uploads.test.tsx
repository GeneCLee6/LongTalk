import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../shared/chat.ts'
import { MAX_FILE_BYTES, type ChatFile } from '../../shared/files.ts'
import type { FilesApi, GrantResult, PutResult } from '../../src/api/files.ts'
import { ChatFileCard } from '../../src/components/ChatFileCard.tsx'
import { ChatPanel } from '../../src/components/ChatPanel.tsx'
import { ChatPreview } from '../../src/components/ChatPreview.tsx'
import { ChatUploads } from '../../src/components/ChatUploads.tsx'
import Lightbox from '../../src/components/Lightbox.tsx'
import { formatBytes } from '../../src/room/chatText.ts'
import { fileTypeLabel, uploadProblemText } from '../../src/room/fileText.ts'
import { FileUploads, type UploadItem } from '../../src/room/fileUploads.ts'
import { fitWithin } from '../../src/room/thumbnail.ts'
import type { FileSharing } from '../../src/room/useFileSharing.ts'
import { setLocale, strings } from '../../src/strings.ts'

const image = (id: string, name = `${id}.png`, thumb = true): ChatFile => ({
  id,
  name,
  size: 2048,
  mime: 'image/png',
  kind: 'image',
  thumb,
  expiresAt: Date.now() + 60_000,
})

const document_: ChatFile = {
  id: 'doc',
  name: '報告.pdf',
  size: 1_572_864,
  mime: 'application/pdf',
  kind: 'file',
  thumb: false,
  expiresAt: Date.now() + 60_000,
}

const message = (id: number, file?: ChatFile): ChatMessage => ({
  id,
  from: 'bob',
  name: 'Bob',
  text: file?.name ?? 'hello',
  at: 1000 + id,
  file,
})

function sharing(overrides: Partial<FileSharing> = {}): FileSharing {
  return {
    uploads: [],
    pick: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(),
    load: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
    download: vi.fn(async () => {}),
    ...overrides,
  }
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:fake')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => vi.restoreAllMocks())

describe('sizes, types and thumbnail sizes', () => {
  it('formats bytes', () => {
    expect(formatBytes(820)).toBe('820 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1_572_864)).toBe('1.5 MB')
    expect(formatBytes(MAX_FILE_BYTES)).toBe('25 MB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00 GB')
  })

  it('names a file’s type', () => {
    expect(fileTypeLabel(document_)).toBe('PDF')
    expect(fileTypeLabel(image('a'))).toBe('PNG')
    expect(fileTypeLabel({ name: 'noext', mime: '', kind: 'file' })).toBe(strings.chat.file.generic)
  })

  it('fits a picture inside the side, never larger', () => {
    expect(fitWithin(4000, 2000, 480)).toEqual({ width: 480, height: 240 })
    expect(fitWithin(1000, 4000, 480)).toEqual({ width: 120, height: 480 })
    expect(fitWithin(100, 50, 480)).toEqual({ width: 100, height: 50 })
    expect(fitWithin(10000, 1, 480)).toEqual({ width: 480, height: 1 })
  })
})

describe('FileUploads', () => {
  const file = (name = 'a.pdf', size = 10, type = 'application/pdf') => {
    return new File([new Uint8Array(size)], name, { type })
  }

  function fakeApi() {
    const puts: {
      id: string
      part: 'file' | 'thumb'
      progress: (done: number) => void
      finish: (result: PutResult) => void
      aborted: boolean
    }[] = []
    const requests: unknown[] = []
    let grants = 0
    let answer: GrantResult | null = null
    const abandoned: string[] = []
    const api: FilesApi = {
      request: async (meta) => {
        requests.push(meta)
        return answer ?? { ok: true, grant: { id: `g${++grants}`, expiresAt: 1 } }
      },
      put: (id, part, _body, onProgress) => {
        const put = {
          id,
          part,
          progress: onProgress,
          finish: (() => {}) as (result: PutResult) => void,
          aborted: false,
        }
        const done = new Promise<PutResult>((resolve) => {
          put.finish = resolve
        })
        puts.push(put)
        return {
          done,
          abort: () => {
            put.aborted = true
            put.finish({ ok: false, problem: 'network' })
          },
        }
      },
      abandon: (id) => abandoned.push(id),
    }
    return {
      api,
      puts,
      requests,
      abandoned,
      setAnswer: (next: GrantResult | null) => {
        answer = next
      },
    }
  }

  const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('refuses at once what the rules refuse, without a request', async () => {
    const { api, requests } = fakeApi()
    const uploads = new FileUploads(api, async () => null)
    uploads.add([
      file('a.exe'),
      new File([], 'empty.txt'),
      Object.defineProperty(file('big.zip'), 'size', { value: MAX_FILE_BYTES + 1 }),
    ])
    await settled()
    expect(requests).toEqual([])
    expect(uploads.items().map((item) => item.problem)).toEqual([
      'blocked_type',
      'empty',
      'too_large',
    ])
    expect(uploads.items().every((item) => item.state === 'failed')).toBe(true)
  })

  it('uploads one at a time, reports progress, and leaves the list when done', async () => {
    const { api, puts } = fakeApi()
    const uploads = new FileUploads(api, async () => null)
    const changes = vi.fn()
    uploads.subscribe(changes)
    uploads.add([file('a.pdf'), file('b.pdf')])
    await settled()
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ id: 'g1', part: 'file' })
    expect(uploads.items().map((item) => item.state)).toEqual(['uploading', 'queued'])
    puts[0].progress(0.5)
    expect(uploads.items()[0].progress).toBe(0.5)
    puts[0].finish({ ok: true })
    await settled()
    expect(uploads.items().map((item) => item.name)).toEqual(['b.pdf'])
    expect(puts).toHaveLength(2)
    puts[1].finish({ ok: true })
    await settled()
    expect(uploads.items()).toEqual([])
    expect(changes).toHaveBeenCalled()
  })

  it('sends the thumbnail first, and goes on if it fails', async () => {
    const { api, puts, requests } = fakeApi()
    const thumb = new Blob(['t'])
    const uploads = new FileUploads(api, async () => thumb)
    uploads.add([file('a.png', 10, 'image/png')])
    await settled()
    expect(requests[0]).toMatchObject({ name: 'a.png', thumb: true })
    expect(puts[0].part).toBe('thumb')
    puts[0].finish({ ok: false, problem: 'unavailable' })
    await settled()
    expect(puts[1].part).toBe('file')
    puts[1].finish({ ok: true })
    await settled()
    expect(uploads.items()).toEqual([])
  })

  it('no thumbnail possible: says so to the server', async () => {
    const { api, puts, requests } = fakeApi()
    const uploads = new FileUploads(api, async () => {
      throw new Error('cannot decode')
    })
    uploads.add([file('a.png', 10, 'image/png')])
    await settled()
    expect(requests[0]).toMatchObject({ thumb: false })
    expect(puts[0].part).toBe('file')
  })

  it('cancelling stops the bytes, gives the grant back and starts the next', async () => {
    const { api, puts, abandoned } = fakeApi()
    const uploads = new FileUploads(api, async () => null)
    uploads.add([file('a.pdf'), file('b.pdf')])
    await settled()
    const [first] = uploads.items()
    uploads.cancel(first.key)
    await settled()
    expect(puts[0].aborted).toBe(true)
    expect(abandoned).toEqual(['g1'])
    expect(uploads.items().map((item) => item.name)).toEqual(['b.pdf'])
    expect(puts[1]).toMatchObject({ id: 'g2' })
  })

  it('a failure says why and can be tried again; the grant is given back', async () => {
    const { api, puts, abandoned, setAnswer } = fakeApi()
    const uploads = new FileUploads(api, async () => null)
    setAnswer({ ok: false, problem: 'rate_limited', retryAfter: 90 })
    uploads.add([file('a.pdf')])
    await settled()
    expect(uploads.items()[0]).toMatchObject({
      state: 'failed',
      problem: 'rate_limited',
      retryAfter: 90,
    })
    setAnswer(null)
    uploads.retry(uploads.items()[0].key)
    await settled()
    puts[0].finish({ ok: false, problem: 'stalled' })
    await settled()
    expect(uploads.items()[0]).toMatchObject({ state: 'failed', problem: 'stalled' })
    expect(abandoned).toEqual(['g1'])
    uploads.dismiss(uploads.items()[0].key)
    expect(uploads.items()).toEqual([])
  })

  it('leaving the room stops everything', async () => {
    const { api, puts, abandoned } = fakeApi()
    const uploads = new FileUploads(api, async () => null)
    uploads.add([file('a.pdf'), file('b.pdf')])
    await settled()
    uploads.stop()
    await settled()
    expect(puts[0].aborted).toBe(true)
    expect(abandoned).toEqual(['g1'])
    expect(puts).toHaveLength(1)
    expect(uploads.items()).toEqual([])
  })
})

describe('ChatUploads', () => {
  const item = (change: Partial<UploadItem>): UploadItem => ({
    key: 1,
    name: 'a.pdf',
    size: 1024 * 1024,
    progress: 0.25,
    state: 'uploading',
    problem: null,
    retryAfter: null,
    ...change,
  })

  it('shows progress and a cancel button', () => {
    const onCancel = vi.fn()
    render(
      <ChatUploads uploads={[item({})]} onCancel={onCancel} onRetry={vi.fn()} onDismiss={vi.fn()} />,
    )
    const bar = screen.getByRole('progressbar', { name: strings.chat.file.uploading('a.pdf') })
    expect(bar).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText(strings.chat.file.progress('256 KB', '1.0 MB'))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: strings.chat.file.cancel('a.pdf') }))
    expect(onCancel).toHaveBeenCalledWith(1)
  })

  it('says why it failed, and offers another try only where it can help', () => {
    const onRetry = vi.fn()
    const onDismiss = vi.fn()
    const { rerender } = render(
      <ChatUploads
        uploads={[item({ state: 'failed', problem: 'network' })]}
        onCancel={vi.fn()}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(strings.chat.file.problems.network)
    fireEvent.click(screen.getByRole('button', { name: strings.chat.file.retry('a.pdf') }))
    expect(onRetry).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: strings.chat.file.dismiss('a.pdf') }))
    expect(onDismiss).toHaveBeenCalledWith(1)
    rerender(
      <ChatUploads
        uploads={[item({ state: 'failed', problem: 'blocked_type' })]}
        onCancel={vi.fn()}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(strings.chat.file.problems.blockedType)
    expect(screen.queryByRole('button', { name: strings.chat.file.retry('a.pdf') })).toBeNull()
  })

  it('has words for every problem, in both languages', () => {
    const problems = [
      'too_large',
      'empty',
      'blocked_type',
      'not_an_image',
      'member_quota',
      'room_quota',
      'rate_limited',
      'storage_full',
      'unauthorized',
      'forbidden',
      'blocked',
      'unavailable',
      'incomplete',
      'bad_request',
      'network',
      'stalled',
    ] as const
    for (const locale of ['zh-TW', 'en'] as const) {
      setLocale(locale, false)
      for (const problem of problems) {
        expect(uploadProblemText({ problem, retryAfter: 90 }).length, problem).toBeGreaterThan(3)
      }
    }
    expect(uploadProblemText({ problem: 'rate_limited', retryAfter: 90 })).toContain('2 minutes')
    setLocale('zh-TW', false)
  })
})

describe('ChatFileCard', () => {
  it('shows the name, size and type, and downloads', async () => {
    const download = vi.fn(async () => {})
    render(
      <ChatFileCard file={document_} load={vi.fn()} download={download} onView={vi.fn()} />,
    )
    expect(screen.getByText('報告.pdf')).toBeInTheDocument()
    expect(screen.getByText(strings.chat.file.details('1.5 MB', 'PDF'))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: strings.chat.file.download('報告.pdf') }))
    await waitFor(() => expect(download).toHaveBeenCalledWith(document_))
  })

  it('a failed download says so; a file gone in the meantime reads as deleted', async () => {
    const download = vi.fn(async () => {
      throw new Error('failed')
    })
    const { unmount } = render(
      <ChatFileCard file={document_} load={vi.fn()} download={download} onView={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: strings.chat.file.download('報告.pdf') }))
    expect(await screen.findByRole('alert')).toHaveTextContent(strings.chat.file.downloadFailed)
    unmount()
    const gone = vi.fn(async () => {
      throw new Error('gone')
    })
    render(<ChatFileCard file={document_} load={vi.fn()} download={gone} onView={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: strings.chat.file.download('報告.pdf') }))
    expect(await screen.findByText(strings.chat.file.expired)).toBeInTheDocument()
  })

  it('past its 24 hours it only says so', () => {
    render(
      <ChatFileCard
        file={document_}
        load={vi.fn()}
        download={vi.fn()}
        onView={vi.fn()}
        now={document_.expiresAt}
      />,
    )
    expect(screen.getByText(strings.chat.file.expired)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('an image shows its thumbnail, fetched as a thumbnail, and opens the viewer', async () => {
    const file = image('p1')
    const load = vi.fn(async () => new Blob(['t'], { type: 'image/jpeg' }))
    const onView = vi.fn()
    render(<ChatFileCard file={file} load={load} download={vi.fn()} onView={onView} />)
    const open = screen.getByRole('button', { name: strings.chat.file.view('p1.png') })
    await waitFor(() => expect(open.querySelector('img')).toHaveAttribute('src', 'blob:fake'))
    expect(load).toHaveBeenCalledWith(file, true)
    fireEvent.click(open)
    expect(onView).toHaveBeenCalledWith(file)
  })

  it('an image without a thumbnail still opens, and no 25 MB is fetched for the chat', () => {
    const file = image('p2', 'p2.png', false)
    const load = vi.fn()
    const onView = vi.fn()
    render(<ChatFileCard file={file} load={load} download={vi.fn()} onView={onView} />)
    fireEvent.click(screen.getByRole('button', { name: strings.chat.file.viewShort }))
    expect(onView).toHaveBeenCalledWith(file)
    expect(load).not.toHaveBeenCalled()
  })
})

describe('Lightbox (e5-t06)', () => {
  const images = [image('one'), image('two'), image('three')]
  const open = (start = images[0], onClose = vi.fn()) => {
    const load = vi.fn(async () => new Blob(['x'], { type: 'image/png' }))
    const download = vi.fn(async () => {})
    render(
      <Lightbox images={images} start={start} load={load} download={download} onClose={onClose} />,
    )
    return { load, download, onClose, dialog: screen.getByRole('dialog') }
  }

  it('is a modal named after the image, and loads the full picture', async () => {
    const { load, dialog } = open()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByRole('heading')).toHaveTextContent('one.png')
    expect(await within(dialog).findByRole('img', { name: 'one.png' })).toHaveAttribute(
      'src',
      'blob:fake',
    )
    expect(load).toHaveBeenCalledWith(images[0], false)
  })

  it('moves focus in, keeps Tab inside, and gives focus back when it closes', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const onClose = vi.fn()
    const load = vi.fn(async () => new Blob(['x']))
    const { unmount } = render(
      <Lightbox images={images} start={images[0]} load={load} download={vi.fn()} onClose={onClose} />,
    )
    const dialog = screen.getByRole('dialog')
    await within(dialog).findByRole('img')
    const close = within(dialog).getByRole('button', { name: strings.common.close })
    expect(close).toHaveFocus()
    const buttons = within(dialog).getAllByRole('button')
    buttons.at(-1)!.focus()
    fireEvent.keyDown(buttons.at(-1)!, { key: 'Tab' })
    expect(buttons[0]).toHaveFocus()
    fireEvent.keyDown(buttons[0], { key: 'Tab', shiftKey: true })
    expect(buttons.at(-1)).toHaveFocus()
    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('Esc closes; the arrows go through the images and wrap; + zooms', async () => {
    const { dialog, onClose, load } = open(images[1])
    await within(dialog).findByRole('img')
    expect(within(dialog).getByText(strings.chat.file.position(2, 3))).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'ArrowRight' })
    await waitFor(() => expect(load).toHaveBeenCalledWith(images[2], false))
    fireEvent.keyDown(dialog, { key: 'ArrowRight' })
    await waitFor(() => expect(load).toHaveBeenCalledWith(images[0], false))
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' })
    await waitFor(() => expect(within(dialog).getByRole('heading')).toHaveTextContent('three.png'))
    await within(dialog).findByRole('img')
    fireEvent.keyDown(dialog, { key: '+' })
    expect(within(dialog).getByRole('button', { name: strings.chat.file.zoomOut })).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: '-' })
    expect(within(dialog).getByRole('button', { name: strings.chat.file.zoomIn })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('says when the picture cannot be loaded; downloads from the viewer', async () => {
    const download = vi.fn(async () => {})
    render(
      <Lightbox
        images={[images[0]]}
        start={images[0]}
        load={async () => {
          throw new Error('gone')
        }}
        download={download}
        onClose={vi.fn()}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(strings.chat.file.loadFailed)
    expect(screen.queryByRole('button', { name: strings.chat.file.previous })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: strings.chat.file.download('one.png') }))
    expect(download).toHaveBeenCalledWith(images[0])
  })
})

describe('ChatPanel with files', () => {
  it('has no attach button without file sharing (text only)', () => {
    render(<ChatPanel messages={[]} you={null} onSend={() => 'sent'} />)
    expect(screen.queryByRole('button', { name: strings.chat.file.attach })).toBeNull()
  })

  it('the picker hands the chosen files over, and the same file can be picked again', () => {
    const files = sharing()
    render(<ChatPanel messages={[]} you={null} onSend={() => 'sent'} files={files} />)
    const input = screen.getByTestId('chat-file-input') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: strings.chat.file.attach }))
    expect(click).toHaveBeenCalled()
    const chosen = new File(['x'], 'a.pdf')
    fireEvent.change(input, { target: { files: [chosen] } })
    expect(files.pick).toHaveBeenCalledWith([chosen])
  })

  it('shows a file message as a card and opens an image in the lazy viewer', async () => {
    const shot = image('shot')
    const files = sharing()
    render(
      <ChatPanel
        messages={[message(1), message(2, document_), message(3, shot)]}
        you="alice"
        onSend={() => 'sent'}
        files={files}
      />,
    )
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(screen.getByText('報告.pdf')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: strings.chat.file.view('shot.png') }))
    })
    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect(within(dialog).getByRole('heading')).toHaveTextContent('shot.png')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows uploads above the box', () => {
    const files = sharing({
      uploads: [
        {
          key: 1,
          name: 'a.pdf',
          size: 10,
          progress: 0.5,
          state: 'uploading',
          problem: null,
          retryAfter: null,
        },
      ],
    })
    render(<ChatPanel messages={[]} you={null} onSend={() => 'sent'} files={files} />)
    expect(screen.getByRole('list', { name: strings.chat.file.uploads })).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
  })

  it('the preview bubble says a file came', () => {
    render(<ChatPreview message={message(1, document_)} onOpen={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(strings.chat.file.message('報告.pdf'))).toBeInTheDocument()
  })
})
