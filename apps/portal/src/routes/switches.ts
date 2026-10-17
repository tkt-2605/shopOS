import { randomBytes } from 'node:crypto'
import type { SqlDriver } from '@shopos/core'
import { readUnverified } from '@shopos/core/shop'
import type { PortalDeps, PortalRequest, PortalResponse } from '../http.js'
import { ok } from '../reply.js'

/*
 * Switch boards: the latest, to any till that asks, and a new one from the
 * vendor. The portal checks only that a board is one and is newer than the
 * last; whether it is genuine is each till's to check, against the repair key
 * it was built with. A board the portal was tricked into holding is a board
 * every till refuses.
 */

export async function latestBoard(db: SqlDriver): Promise<{ token: string; issuedAt: string } | null> {
  const row = await db.get<{ token: string; issued_at: string }>(
    'SELECT token, issued_at FROM switch_boards ORDER BY issued_at DESC LIMIT 1',
  )
  return row === undefined ? null : { token: row.token, issuedAt: row.issued_at }
}

export type SetBoard = { ok: true; issuedAt: string } | { ok: false; detail: string }

export async function setBoard(db: SqlDriver, token: string, setBy: string, now: Date): Promise<SetBoard> {
  const payload = readUnverified(token)
  if (payload === null || payload['kind'] !== 'switches' || typeof payload['issuedAt'] !== 'string') {
    return { ok: false, detail: 'That is not a switch board. Make one with tools/support/switches.ts.' }
  }
  const issuedAt = payload['issuedAt']
  const held = await latestBoard(db)
  if (held !== null && Date.parse(issuedAt) <= Date.parse(held.issuedAt)) {
    return { ok: false, detail: `A newer board is already out (${held.issuedAt}); tills would ignore this one.` }
  }
  await db.execute(
    'INSERT INTO switch_boards (id, issued_at, token, set_by, set_at) VALUES (?, ?, ?, ?, ?)',
    [randomBytes(16).toString('hex'), issuedAt, token.trim(), setBy, now.toISOString()],
  )
  return { ok: true, issuedAt }
}

/** `GET /v1/switches`, open to every till: the board is signed, and says nothing secret. */
export async function switchRoutes(deps: PortalDeps, request: PortalRequest): Promise<PortalResponse | null> {
  if (request.method !== 'GET' || request.path !== '/v1/switches') return null
  const board = await latestBoard(deps.db)
  return board === null ? { status: 404, body: { error: 'NO_BOARD' } } : ok(board)
}

export function boardFrom(body: unknown): string | null {
  const token = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['token'] : null
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null
}

