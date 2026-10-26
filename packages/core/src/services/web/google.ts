/*
 * Checking a "Sign in with Google" token on the till, with nobody's server in
 * between.
 *
 * The storefront hands the till the ID token Google gave the phone: a JWT
 * signed with one of Google's RSA keys. The till checks the signature against
 * those keys (fetched by the Rust side from Google, `web_google_keys`), and
 * that the token was made for this shop's storefront, by Google, recently, for
 * an address Google has checked. What it keeps is Google's `sub` -- the
 * person's id at Google, which never changes. The email is a label; an email
 * is never the identity (`apps/portal/src/auth/oauth.ts` says why).
 *
 * Pure: the keys and the clock are passed in.
 */

export interface Jwk {
  kid: string
  kty: string
  n: string
  e: string
  alg?: string
}

export interface Jwks {
  keys: Jwk[]
}

export interface GoogleIdentity {
  sub: string
  email: string | null
  name: string | null
}

export type GoogleVerdict =
  | { ok: true; identity: GoogleIdentity }
  | { ok: false; code: 'MALFORMED' | 'UNKNOWN_KEY' | 'BAD_SIGNATURE' | 'WRONG_ISSUER' | 'WRONG_AUDIENCE' | 'EXPIRED' | 'EMAIL_NOT_VERIFIED' }

const ISSUERS = ['accounts.google.com', 'https://accounts.google.com']
/** How far a phone's clock and the till's may disagree. */
const SKEW_S = 120

export async function verifyGoogleIdToken(
  token: string, jwks: Jwks, clientId: string, now: Date,
): Promise<GoogleVerdict> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, code: 'MALFORMED' }
  const [head64, body64, sig64] = parts as [string, string, string]

  let header: { alg?: string; kid?: string }
  let claims: Record<string, unknown>
  let signature: Uint8Array<ArrayBuffer>
  try {
    header = JSON.parse(decodeText(head64))
    claims = JSON.parse(decodeText(body64))
    signature = base64url(sig64)
  } catch {
    return { ok: false, code: 'MALFORMED' }
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, code: 'MALFORMED' }

  const jwk = jwks.keys.find((k) => k.kid === header.kid && k.kty === 'RSA')
  if (!jwk) return { ok: false, code: 'UNKNOWN_KEY' }

  const key = await globalThis.crypto.subtle.importKey(
    'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  )
  const signed = new TextEncoder().encode(`${head64}.${body64}`)
  const good = await globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed)
  if (!good) return { ok: false, code: 'BAD_SIGNATURE' }

  if (!ISSUERS.includes(String(claims['iss']))) return { ok: false, code: 'WRONG_ISSUER' }
  if (claims['aud'] !== clientId) return { ok: false, code: 'WRONG_AUDIENCE' }
  const seconds = Math.floor(now.getTime() / 1000)
  const exp = Number(claims['exp'])
  if (!Number.isFinite(exp) || exp + SKEW_S < seconds) return { ok: false, code: 'EXPIRED' }
  const iat = Number(claims['iat'])
  if (Number.isFinite(iat) && iat - SKEW_S > seconds) return { ok: false, code: 'EXPIRED' }
  const sub = claims['sub']
  if (typeof sub !== 'string' || sub === '') return { ok: false, code: 'MALFORMED' }
  const email = typeof claims['email'] === 'string' ? claims['email'] : null
  if (email !== null && claims['email_verified'] !== true) return { ok: false, code: 'EMAIL_NOT_VERIFIED' }

  return {
    ok: true,
    identity: { sub, email, name: typeof claims['name'] === 'string' ? claims['name'] : null },
  }
}

/** Google's keys as the Rust side fetched them, or null when the text is not a key set. */
export function parseJwks(text: string): Jwks | null {
  try {
    const parsed = JSON.parse(text) as { keys?: unknown }
    if (!Array.isArray(parsed.keys)) return null
    const keys = parsed.keys.filter((k): k is Jwk =>
      typeof k === 'object' && k !== null
      && typeof (k as Jwk).kid === 'string' && typeof (k as Jwk).n === 'string' && typeof (k as Jwk).e === 'string'
      && (k as Jwk).kty === 'RSA')
    return keys.length > 0 ? { keys } : null
  } catch {
    return null
  }
}

function base64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const binary = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function decodeText(text: string): string {
  return new TextDecoder().decode(base64url(text))
}
