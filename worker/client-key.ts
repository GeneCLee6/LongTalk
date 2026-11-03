// A client's network as the abuse protection keeps it (I1, e11-t05): a keyed hash, never the
// address. IPv6 is cut to its /64 first (one home or phone gets a whole /64, so a limit per full
// address would be a limit per nothing). With the optional IP_HASH_PEPPER secret the hash is an
// HMAC under it, so nobody with the storage but not the secret can test guesses of addresses
// (IPv4 has only 2^32); without it the hash is still one-way but guessable by brute force.

export interface ClientKeyEnv {
  /** Optional Worker secret: a long random string keying the client hashes (DEPLOY.md §11) */
  IP_HASH_PEPPER?: string
}

const encoder = new TextEncoder()
/** Without a pepper: a fixed label, so these hashes never equal another feature's */
const DEFAULT_LABEL = 'longtalk:client:v1'

/** The address as one network: IPv4 as it is, IPv6 as its first four groups (/64), lower case */
export function networkOf(ip: string): string | null {
  const value = ip.trim()
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255) ? value : null
  }
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return null
  // IPv4-mapped (::ffff:1.2.3.4) is the IPv4 address
  const mapped = /^::ffff:((\d{1,3}\.){3}\d{1,3})$/i.exec(value)
  if (mapped) return networkOf(mapped[1])
  const halves = value.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  // An embedded IPv4 tail counts as two groups; only the first four groups matter here
  const groups = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (groups < 0) return null
  const all = [...head, ...Array<string>(groups).fill('0'), ...tail]
  if (halves.length === 1 && all.length < 4) return null
  const prefix = all.slice(0, 4)
  if (prefix.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return null
  return prefix.map((group) => group.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64'
}

/** Addresses that never come from Cloudflare's edge: local development and tests */
export function isLocalAddress(ip: string | null): boolean {
  if (!ip) return true
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.') || ip === 'localhost'
}

let cachedKey: { pepper: string; key: CryptoKey } | null = null

async function hmacKey(pepper: string): Promise<CryptoKey> {
  if (cachedKey?.pepper === pepper) return cachedKey.key
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  cachedKey = { pepper, key }
  return key
}

/**
 * The client key of an address: 24 hex digits (96 bits) of HMAC-SHA-256(pepper, network), or
 * SHA-256 of a fixed label and the network without a pepper. Null for something that is not an
 * address.
 */
export async function clientKeyOf(ip: string, env: ClientKeyEnv): Promise<string | null> {
  const network = networkOf(ip)
  if (!network) return null
  const data = encoder.encode(network)
  const digest = env.IP_HASH_PEPPER
    ? await crypto.subtle.sign('HMAC', await hmacKey(env.IP_HASH_PEPPER), data)
    : await crypto.subtle.digest('SHA-256', encoder.encode(`${DEFAULT_LABEL}:${network}`))
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The client key of a request (from CF-Connecting-IP, which Cloudflare's edge sets and a client
 * cannot), or null when it has no usable address: local development, where nothing is limited
 */
export async function requestClientKey(
  request: Request,
  env: ClientKeyEnv,
): Promise<string | null> {
  const ip = request.headers.get('CF-Connecting-IP')
  if (isLocalAddress(ip)) return null
  return clientKeyOf(ip!, env)
}
