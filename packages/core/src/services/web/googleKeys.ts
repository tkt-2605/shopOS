import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { parseJwks, type Jwks } from './google.js'

/*
 * Google's signing keys as the main last fetched them, kept in `web_state` so
 * a main that starts with the line down can still check sign-ins with the keys
 * it had. Google rotates them every few weeks and serves the old beside the
 * new for days, so yesterday's set is almost always still good.
 */

const KEY = 'google_keys'

export async function heldGoogleKeys(db: SqlDriver): Promise<Jwks | null> {
  const [row] = await q(db).select({ value: schema.webState.value }).from(schema.webState)
    .where(eq(schema.webState.key, KEY))
  return row ? parseJwks(row.value) : null
}

/** Keeps a freshly fetched set, if it is one. Answers the set now held. */
export async function rememberGoogleKeys(db: SqlDriver, text: string | null): Promise<Jwks | null> {
  const fresh = text === null ? null : parseJwks(text)
  if (fresh === null) return heldGoogleKeys(db)
  const value = JSON.stringify(fresh)
  await q(db).insert(schema.webState).values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.webState.key, set: { value } })
  return fresh
}
