import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '../../shared/protocol.ts'
import { App } from '../../src/App.tsx'

/** Stands in for the browser's WebSocket: every room answers with a welcome from one member */
class WelcomingSocket {
  static instances: WelcomingSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
    WelcomingSocket.instances.push(this)
    queueMicrotask(() => {
      if (!this.onmessage) return
      this.readyState = 1
      this.onopen?.()
      const roomId = /rooms\/([^/]+)\/ws/.exec(url)?.[1] ?? ''
      const state = { room: { id: roomId, createdAt: 1 }, members: { a: { id: 'a', joinedAt: 1 } } }
      this.onmessage({
        data: JSON.stringify({ t: 'welcome', v: PROTOCOL_VERSION, you: 'a', rev: 1, state }),
      })
    })
  }
  send() {}
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals()
  WelcomingSocket.instances = []
})

describe('App', () => {
  it('shows the home page at /', () => {
    window.history.pushState({}, '', '/')
    render(<App />)
    expect(screen.getByRole('heading', { name: 'LongTalk' })).toBeInTheDocument()
  })

  it('creates a room from the home page and goes into it', async () => {
    vi.stubGlobal('WebSocket', WelcomingSocket)
    const fetch = vi.fn(async () => Response.json({ id: 'abcdefghij' }, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    window.history.pushState({}, '', '/')
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '建立會議室' }))
    expect(await screen.findByRole('heading', { name: '會議室 abcdefghij' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/r/abcdefghij')
    expect(fetch).toHaveBeenCalledWith('/api/rooms', { method: 'POST' })
    expect(await screen.findByText('目前 1 人在線')).toBeInTheDocument()
    expect(WelcomingSocket.instances.at(-1)?.url).toMatch(/\/api\/rooms\/abcdefghij\/ws\?v=1$/)
  })

  it('says so when the room cannot be created', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    )
    window.history.pushState({}, '', '/')
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '建立會議室' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('建立會議室失敗')
    expect(screen.getByRole('button', { name: '建立會議室' })).toBeEnabled()
  })

  it('does not connect to a room id that cannot exist', async () => {
    vi.stubGlobal('WebSocket', WelcomingSocket)
    window.history.pushState({}, '', '/r/abc123')
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到這間會議室')
    expect(WelcomingSocket.instances).toHaveLength(0)
  })
})
