// The account API's test bench (I2, I3): a real SQLite with the real migrations (d1.ts), a
// software passkey authenticator per browser, stand-in rooms and a stand-in GuardDO
import { expect } from 'vitest'
import type { MeResponse } from '../../shared/account.ts'
import type { GuardDeps } from '../../worker/abuse.ts'
import { handleAccount, type AccountDeps } from '../../worker/accounts.ts'
import type { Env } from '../../worker/app.ts'
import { handleMeetingView } from '../../worker/meetings.ts'
import type { RoomSettings, SettingsChange } from '../../worker/room-host.ts'
import { SESSION_COOKIE } from '../../worker/session.ts'
import { SoftAuthenticator } from './authenticator.ts'
import { fakeD1 } from './d1.ts'

export const ORIGIN = 'https://longtalk.example'

type Room = { owner: string; settings: RoomSettings }

/** `migrations` leaves later ones out (a database not migrated yet) */
export function setup(migrations?: string[]) {
  const { db, sqlite } = fakeD1(migrations)
  let clock = 1_800_000_000_000
  const rooms = new Map<string, Room>()
  const destroyed: string[] = []
  const limits: string[] = []
  let refuse: string | null = null
  const guard = {
    create: async () => ({ ok: true }) as const,
    limit: async (kind: string) => {
      limits.push(kind)
      return kind === refuse ? { ok: false as const, retryAfterMs: 61_000 } : ({ ok: true } as const)
    },
    note: async () => {},
    blocked: async () => [],
  } as unknown as GuardDeps
  const deps: AccountDeps = {
    guard,
    now: () => clock,
    room: (slug) =>
      ({
        createPersistent: async (record: { owner: string }, name: string | null) => {
          if (rooms.has(slug)) return false
          rooms.set(slug, {
            owner: record.owner,
            settings: {
              name,
              waitingRoom: false,
              locked: false,
              password: false,
              memberCount: 0,
              startMuted: false,
              allowAnnotation: true,
              allowRecording: true,
            },
          })
          return true
        },
        settings: async () => rooms.get(slug)?.settings ?? null,
        updateSettings: async (change: SettingsChange) => {
          const room = rooms.get(slug)
          if (!room) return null
          const { password, ...rest } = change
          room.settings = {
            ...room.settings,
            ...rest,
            ...(password !== undefined ? { password: password !== null } : {}),
          }
          return room.settings
        },
        destroy: async () => {
          destroyed.push(slug)
          rooms.delete(slug)
        },
      }) as unknown as ReturnType<AccountDeps['room']>,
  }
  const env = { DB: db } as unknown as Env

  /** GET /api/meetings/<id> as anyone (no cookie) sees it */
  const view = async (id: string) => {
    const request = new Request(`${ORIGIN}/api/meetings/${id}`)
    const res = await handleMeetingView(request, env, new URL(request.url), { guard, now: () => clock })
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }

  /** A browser: its own cookie jar */
  class Browser {
    cookie: string | null = null
    readonly authenticator = new SoftAuthenticator()

    async call(
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<{ status: number; json: Record<string, unknown>; setCookie: string | null }> {
      const init: RequestInit = {
        method,
        headers: {
          ...(method === 'GET' ? {} : { Origin: ORIGIN }),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.cookie ? { Cookie: `${SESSION_COOKIE}=${this.cookie}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }
      const request = new Request(`${ORIGIN}/api/account${path}`, init)
      const res = await handleAccount(request, env, new URL(request.url), deps)
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) {
        const value = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(setCookie)![1]
        this.cookie = value === '' ? null : value
      }
      const text = await res.text()
      return { status: res.status, json: text ? JSON.parse(text) : {}, setCookie }
    }

    async signUp(name: string) {
      const options = await this.call('POST', '/register/options', { name })
      expect(options.status).toBe(200)
      const credential = await this.authenticator.create(options.json.options as never, ORIGIN)
      return this.call('POST', '/register', { credential })
    }

    async signIn(authenticator = this.authenticator) {
      const options = await this.call('POST', '/login/options', {})
      const credential = await authenticator.get(options.json.options as never, ORIGIN)
      return this.call('POST', '/login', { credential })
    }

    async me(): Promise<MeResponse> {
      const res = await this.call('GET', '')
      expect(res.status).toBe(200)
      return res.json as unknown as MeResponse
    }
  }

  return {
    sqlite,
    rooms,
    destroyed,
    limits,
    Browser,
    view,
    now: () => clock,
    tick: (ms: number) => {
      clock += ms
    },
    refuseLimit: (kind: string | null) => {
      refuse = kind
    },
    count: (table: string) =>
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  }
}
