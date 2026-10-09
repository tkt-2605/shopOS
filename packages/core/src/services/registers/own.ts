import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { deviceId } from '../../device.js'
import { newId } from '../../ids.js'
import { writeAudit } from '../../integrity/audit.js'

/*
 * The counter a till is born with.
 *
 * Two tills made "CR1" while out of touch, because a person typed the prefix and
 * the app asked each of them to. A prefix is what keeps two tills from minting
 * one bill number, so it is not a thing to leave to whoever is standing there:
 * a till's counter is made by the till, named from the till, and never moves.
 */

const SPACE = 36 ** 4

/**
 * Four characters from the machine's own id, the same four every time.
 *
 * Four because a bill number is `B` + prefix + `/2627/00001` and Rule 46(b)
 * stops at sixteen (see `numbering.ts`). A device id is a random UUID, so two
 * tills share a stem about once in 1.7 million; `salt` is only for the day a
 * stem is already on a counter in this shop's books.
 */
export function prefixFor(device: string, salt = 0): string {
  // FNV-1a: small, stable across runtimes, and nothing here needs to be secret.
  let h = 0x811c9dc5
  for (const ch of `${device}:${salt}`) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h % SPACE).toString(36).toUpperCase().padStart(4, '0')
}

/**
 * The counter this machine holds, made on the spot if it holds none.
 *
 * Returns null only when the machine cannot say who it is. The caller records
 * the answer on the machine (`device.json`); nothing here asks anyone anything.
 */
export async function ensureOwnRegister(db: SqlDriver, me: string | null = deviceId()): Promise<string | null> {
  if (me === null) return null

  const [held] = await q(db)
    .select({ id: schema.registers.id })
    .from(schema.registers)
    .where(eq(schema.registers.claimedBy, me))
  if (held) return held.id

  const taken = await q(db)
    .select({ name: schema.registers.name, prefix: schema.registers.prefix })
    .from(schema.registers)
  const prefixes = new Set(taken.map((r) => r.prefix))
  const names = new Set(taken.map((r) => r.name))

  let salt = 0
  let prefix = prefixFor(me, salt)
  while (prefixes.has(prefix) || names.has(`Counter ${prefix}`)) prefix = prefixFor(me, ++salt)

  const id = newId()
  const now = new Date().toISOString()
  const name = `Counter ${prefix}`
  await db.transaction(async (tx) => {
    await q(tx).insert(schema.registers)
      .values({ id, name, prefix, claimedBy: me, claimedAt: now, createdAt: now, updatedAt: now })
    await writeAudit(tx, { actorId: null }, {
      entity: 'registers', entityId: id, action: 'create', after: { name, prefix },
    })
  })
  return id
}
