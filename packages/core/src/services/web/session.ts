import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'

/*
 * A customer's session on the storefront: their account id and an expiry,
 * signed with a key that lives only on the main (`web_state`, never synced).
 *
 * Signed rather than stored, so a session costs no row and no write per
 * request, and a phone that is lost can be signed out of by nothing more than
 * waiting -- thirty days. A new main has a new key, so its customers sign in
 * again; that is the cheapest correct answer to a key that must not travel.
 */

const SESSION_DAYS = 30
const SECRET_KEY = 'session_secret'

export interface Session {
  accountId: string
  expiresAt: number
}

/** When a session was issued: it carries only its expiry, which is a fixed time after. */
export function issuedAt(session: Session): number {
  return session.expiresAt - SESSION_DAYS * 86_400_000
}

export async function issueSession(db: SqlDriver, accountId: string, now: Date): Promise<string> {
  const payload = encode(JSON.stringify({ a: accountId, e: now.getTime() + SESSION_DAYS * 86_400_000 }))
  return `${payload}.${await sign(await secret(db), payload)}`
}

export async function readSession(db: SqlDriver, token: string | null, now: Date): Promise<Session | null> {
  if (!token) return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const expected = await sign(await secret(db), payload)
  if (!sameText(expected, token.slice(dot + 1))) return null
  try {
    const { a, e } = JSON.parse(decode(payload)) as { a?: unknown; e?: unknown }
    if (typeof a !== 'string' || typeof e !== 'number' || e < now.getTime()) return null
    return { accountId: a, expiresAt: e }
  } catch {
    return null
  }
}

/** The bearer token from an `Authorization` header, or null. */
export function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  return match?.[1] ?? null
}

async function secret(db: SqlDriver): Promise<string> {
  const [held] = await q(db).select({ value: schema.webState.value }).from(schema.webState)
    .where(eq(schema.webState.key, SECRET_KEY))
  if (held) return held.value
  const made = [...globalThis.crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  /* Two first requests at once would each make one; the second insert loses
     and both then read the one that won. */
  await q(db).insert(schema.webState).values({ key: SECRET_KEY, value: made }).onConflictDoNothing()
  const [won] = await q(db).select({ value: schema.webState.value }).from(schema.webState)
    .where(eq(schema.webState.key, SECRET_KEY))
  return won!.value
}

async function sign(key: string, message: string): Promise<string> {
  const k = await globalThis.crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await globalThis.crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message))
  return encodeBytes(new Uint8Array(mac))
}

/** Takes as long when the first character differs as when the last one does. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function encode(text: string): string {
  return encodeBytes(new TextEncoder().encode(text))
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decode(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
