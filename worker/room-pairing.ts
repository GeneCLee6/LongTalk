import {
  PAIRING_CODE_TTL_MS,
  PAIRING_NETWORK_FAIL_RATE,
  PAIRING_ROOM_MAX_FAILS,
  newPairingCode,
} from '../shared/control.ts'

/** An open pairing code: whose it is (the member who asked) and when it runs out */
export type PairingCode = { owner: string; code: string; expiresAt: number }

/**
 * What survives the object being evicted or hibernating (one storage key, written on every
 * change): the open codes, and the wrong codes still counting. The failures are stored too, so a
 * guesser cannot reset the limits by letting the object hibernate between guesses.
 */
export type PairingState = {
  codes: PairingCode[]
  /** When each wrong code came, room-wide (within PAIRING_CODE_TTL_MS) */
  fails: number[]
  /** When each wrong code came, by network (addressKey digest; within PAIRING_NETWORK_FAIL_RATE) */
  networks: Record<string, number[]>
}

/** The most networks whose failures are kept (the oldest goes first): bounded storage */
const MAX_NETWORKS = 200

/** What a wrong code did: the codes it voided (their owners), when it was the room's last straw */
export type PairingFail = { voided: string[] }

/**
 * Equal codes in a time that does not depend on where they differ. Both are normalized
 * (normalizePairingCode), so their length is public and always the same
 */
function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * The room's pairing codes (N2, e9-t02; docs/PRD/f-remote-control-security.md §5.1). Who may ask
 * for one, and what pairing makes, is RoomHost's to decide; this keeps the codes (one per member,
 * PAIRING_CODE_TTL_MS, used once) and the wrong-code limits: per network PAIRING_NETWORK_FAIL_RATE,
 * room-wide PAIRING_ROOM_MAX_FAILS within PAIRING_CODE_TTL_MS, which voids every open code.
 */
export class RoomPairing {
  private readonly codes = new Map<string, PairingCode>()
  private fails: number[] = []
  private readonly networks = new Map<string, number[]>()

  constructor(stored: PairingState | null | undefined = null) {
    for (const entry of stored?.codes ?? []) this.codes.set(entry.owner, { ...entry })
    this.fails = [...(stored?.fails ?? [])]
    for (const [network, at] of Object.entries(stored?.networks ?? {})) {
      this.networks.set(network, [...at])
    }
  }

  get stored(): PairingState {
    return {
      codes: [...this.codes.values()].map((entry) => ({ ...entry })),
      fails: [...this.fails],
      networks: Object.fromEntries([...this.networks].map(([network, at]) => [network, [...at]])),
    }
  }

  /** The member's open code (expired or not: `prune` drops those) */
  codeOf(owner: string): PairingCode | null {
    return this.codes.get(owner) ?? null
  }

  /** A new code for `owner`, replacing any it had */
  issue(owner: string, now: number): PairingCode {
    let code = newPairingCode()
    // Two open codes the same would pair the wrong member's computer (about 1 in 10¹² a pair)
    while ([...this.codes.values()].some((entry) => entry.code === code)) code = newPairingCode()
    const entry = { owner, code, expiresAt: now + PAIRING_CODE_TTL_MS }
    this.codes.set(owner, entry)
    return { ...entry }
  }

  /** Voids the member's code; false when it had none */
  cancel(owner: string): boolean {
    return this.codes.delete(owner)
  }

  /**
   * The owner of the open, unexpired code equal to `code`, which is used up; null when none is.
   * Every open code is compared, each in constant time, so the time says nothing about which.
   */
  take(code: string, now: number): string | null {
    let found: PairingCode | null = null
    for (const entry of this.codes.values()) {
      if (sameCode(entry.code, code) && entry.expiresAt > now) found = entry
    }
    if (found === null) return null
    this.codes.delete(found.owner)
    return found.owner
  }

  /** Whether `network` used up its wrong codes for now (null: unknown address, never limited) */
  blocked(network: string | null, now: number): boolean {
    if (network === null) return false
    const recent = this.recent(this.networks.get(network), now, PAIRING_NETWORK_FAIL_RATE.windowMs)
    return recent.length >= PAIRING_NETWORK_FAIL_RATE.count
  }

  /**
   * A wrong code from `network`. The room's PAIRING_ROOM_MAX_FAILS-th within PAIRING_CODE_TTL_MS
   * voids every open code (their owners are returned) and starts the count again.
   */
  fail(network: string | null, now: number): PairingFail {
    if (network !== null) {
      const recent = this.recent(
        this.networks.get(network),
        now,
        PAIRING_NETWORK_FAIL_RATE.windowMs,
      )
      this.networks.delete(network)
      this.networks.set(network, [...recent, now])
      while (this.networks.size > MAX_NETWORKS) {
        this.networks.delete(this.networks.keys().next().value!)
      }
    }
    this.fails = [...this.recent(this.fails, now, PAIRING_CODE_TTL_MS), now]
    if (this.fails.length < PAIRING_ROOM_MAX_FAILS) return { voided: [] }
    this.fails = []
    const voided = [...this.codes.keys()]
    this.codes.clear()
    return { voided }
  }

  /** Drops what ran out: the owners of the codes that expired (to tell them), and old failures */
  prune(now: number): string[] {
    const expired: string[] = []
    for (const [owner, entry] of this.codes) {
      if (entry.expiresAt > now) continue
      this.codes.delete(owner)
      expired.push(owner)
    }
    this.fails = this.recent(this.fails, now, PAIRING_CODE_TTL_MS)
    for (const [network, at] of this.networks) {
      const recent = this.recent(at, now, PAIRING_NETWORK_FAIL_RATE.windowMs)
      if (recent.length === 0) this.networks.delete(network)
      else this.networks.set(network, recent)
    }
    return expired
  }

  /** When the next code runs out or the next failure stops counting; null for nothing */
  due(): number | null {
    let next: number | null = null
    const at = (time: number) => {
      if (next === null || time < next) next = time
    }
    for (const entry of this.codes.values()) at(entry.expiresAt)
    if (this.fails.length > 0) at(this.fails[0] + PAIRING_CODE_TTL_MS)
    for (const times of this.networks.values()) {
      if (times.length > 0) at(times[0] + PAIRING_NETWORK_FAIL_RATE.windowMs)
    }
    return next
  }

  /** Whether anything is kept (nothing to store or schedule otherwise) */
  get empty(): boolean {
    return this.codes.size === 0 && this.fails.length === 0 && this.networks.size === 0
  }

  reset(): void {
    this.codes.clear()
    this.fails = []
    this.networks.clear()
  }

  private recent(times: readonly number[] | undefined, now: number, windowMs: number): number[] {
    return (times ?? []).filter((at) => now - at < windowMs)
  }
}
