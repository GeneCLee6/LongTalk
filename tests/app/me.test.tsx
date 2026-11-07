// I2 (e1-t12, e1-t13): the /me page against a stand-in /api/account and a stand-in WebAuthn
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../../shared/account.ts'
import MePage from '../../src/pages/MePage.tsx'
import { loadAccountHint } from '../../src/room/session.ts'
import { zhTW as text } from '../../src/i18n/zh-TW.ts'

const ME: MeResponse = {
  account: { id: 'acc', name: 'Gene', createdAt: Date.UTC(2026, 10, 1) },
  passkeys: [
    {
      id: 'cred-1',
      createdAt: Date.UTC(2026, 10, 1),
      lastUsedAt: null,
      provider: 'icloud',
      backedUp: true,
    },
  ],
  sessions: [
    { id: 's1', createdAt: Date.UTC(2026, 10, 1), lastSeenAt: Date.UTC(2026, 10, 2), current: true },
    { id: 's2', createdAt: Date.UTC(2026, 9, 1), lastSeenAt: Date.UTC(2026, 9, 2), current: false },
  ],
  rooms: [
    {
      slug: 'gene-weekly',
      createdAt: 1,
      name: '週會',
      waitingRoom: true,
      locked: false,
      password: true,
      memberCount: 0,
      startMuted: false,
      allowAnnotation: true,
      allowRecording: true,
    },
  ],
  meetings: [],
}

type Call = { method: string; path: string; body: unknown }

function stubApi(signedIn: { value: boolean }) {
  const calls: Call[] = []
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const path = input.replace('/api/account', '')
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (method === 'GET' && path === '') return signedIn.value ? json(ME) : json({ error: 'signed_out' }, 401)
    if (path === '/register/options') {
      return json({
        options: {
          rp: { id: 'localhost', name: 'LongTalk' },
          user: { id: 'YWNj', name: 'Gene', displayName: 'Gene' },
          challenge: 'Y2hhbGxlbmdl',
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        },
      })
    }
    if (path === '/register') {
      signedIn.value = true
      return json({ account: ME.account }, 201)
    }
    if (method === 'DELETE' && path === '') {
      signedIn.value = false
      return new Response(null, { status: 204 })
    }
    if (method === 'POST' && path === '/rooms') return json({ error: 'slug_taken' }, 409)
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetch)
  return calls
}

class FakeCredential {
  id = 'Y3JlZA'
  rawId = new Uint8Array([1, 2, 3]).buffer
  type = 'public-key'
  response = {
    clientDataJSON: new Uint8Array([4]).buffer,
    attestationObject: new Uint8Array([5]).buffer,
    getTransports: () => ['internal'],
  }
}

function stubWebAuthn() {
  vi.stubGlobal('PublicKeyCredential', FakeCredential)
  const create = vi.fn(async () => new FakeCredential())
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create, get: vi.fn() },
  })
  return create
}

const visit = () =>
  render(
    <MemoryRouter>
      <MePage />
    </MemoryRouter>,
  )

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'credentials')
})

describe('/me (I2)', () => {
  it('says when the browser has no passkeys; everything else still works without an account', async () => {
    stubApi({ value: false })
    visit()
    expect(await screen.findByText(text.account.noPasskeys)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: text.account.signIn })).toBeNull()
  })

  it('makes an account with a name and a passkey, then shows it', async () => {
    const calls = stubApi({ value: false })
    const create = stubWebAuthn()
    visit()
    const submit = await screen.findByRole('button', { name: text.account.signUp })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: text.account.nameLabel }), {
      target: { value: 'Gene' },
    })
    fireEvent.click(submit)
    expect(await screen.findByText(text.account.signedInAs('Gene'))).toBeInTheDocument()
    expect(create).toHaveBeenCalledTimes(1)
    const [{ publicKey }] = create.mock.calls[0] as unknown as [{ publicKey: PublicKeyCredentialCreationOptions }]
    expect(String.fromCharCode(...new Uint8Array(publicKey.challenge as ArrayBuffer))).toBe('challenge')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET ',
      'POST /register/options',
      'POST /register',
      'GET ',
    ])
    expect(calls[2].body).toMatchObject({ credential: { id: 'Y3JlZA', rawId: 'AQID', response: { transports: ['internal'] } } })
    expect(loadAccountHint()).toBe('Gene')
  })

  it('sets a persistent room’s defaults (L5, e1-t18): recording allowed is only a yes to asking', async () => {
    const calls = stubApi({ value: true })
    stubWebAuthn()
    visit()
    await screen.findByText('週會')
    fireEvent.click(screen.getByRole('button', { name: text.account.editRoomLabel('gene-weekly') }))
    const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement
    expect(box(text.account.startMuted).checked).toBe(false)
    expect(box(text.account.allowAnnotation).checked).toBe(true)
    expect(box(text.account.allowRecording).checked).toBe(true)
    expect(screen.getByText(text.account.settingsHint).textContent).toContain('明確同意')
    fireEvent.click(box(text.account.startMuted))
    fireEvent.click(box(text.account.allowRecording))
    fireEvent.click(screen.getByRole('button', { name: text.account.saveRoom }))
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({
        startMuted: true,
        allowAnnotation: true,
        allowRecording: false,
      }),
    )
  })

  it('lists rooms, passkeys and browsers; the last passkey stays; deleting signs out', async () => {
    const calls = stubApi({ value: true })
    stubWebAuthn()
    visit()
    const rooms = await screen.findByRole('region', { name: text.account.roomsTitle })
    expect(within(rooms).getByText('週會')).toBeInTheDocument()
    expect(within(rooms).getByText(/gene-weekly/)).toBeInTheDocument()
    expect(within(rooms).getByText(`${text.account.waitingRoom} · ${text.account.passwordSet}`)).toBeInTheDocument()
    const passkeys = screen.getByRole('region', { name: text.account.passkeysTitle })
    expect(within(passkeys).getByText(text.account.providers.icloud)).toBeInTheDocument()
    expect(within(passkeys).getByRole('button', { name: /^移除/ })).toBeDisabled()
    const sessions = screen.getByRole('region', { name: text.account.sessionsTitle })
    expect(within(sessions).getByText(text.account.thisBrowser)).toBeInTheDocument()
    expect(within(sessions).getByRole('button', { name: text.account.signOutOthers })).toBeInTheDocument()
    // A slug the Worker would refuse is explained before asking it
    fireEvent.change(within(rooms).getByRole('textbox', { name: text.account.slugLabel }), {
      target: { value: 'admin' },
    })
    expect(within(rooms).getByText(text.account.slugProblems.reserved)).toBeInTheDocument()
    expect(within(rooms).getByRole('button', { name: text.account.createRoom })).toBeDisabled()
    // The Worker's refusal is said too
    fireEvent.change(within(rooms).getByRole('textbox', { name: text.account.slugLabel }), {
      target: { value: 'taken-one' },
    })
    fireEvent.click(within(rooms).getByRole('button', { name: text.account.createRoom }))
    expect(await screen.findByRole('alert', { name: '' })).toHaveTextContent(text.account.errors.slug_taken)
    fireEvent.click(screen.getByRole('button', { name: text.account.deleteAccount }))
    const dialog = screen.getByRole('alertdialog', { name: text.account.deleteConfirmTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: text.account.deleteAccount }))
    expect(await screen.findByRole('button', { name: text.account.signIn })).toBeInTheDocument()
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '')).toBe(true))
    expect(loadAccountHint()).toBeNull()
  })
})
