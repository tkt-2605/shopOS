import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'

/*
 * The shop's settings table: one key, one value.
 *
 * Its own file because nearly every service reads a setting, and bootstrap --
 * where these used to live -- also reaches into the services that seed roles and
 * backfill customer codes. A read of one row should not drag its importer into
 * that circle, and here it cannot: this file imports nothing but the database.
 */

/**
 * Where the shop's answer for a walk-in customer is kept.
 *
 * A setting rather than a column since 043. `price_lists.is_default` was guarded
 * by `UNIQUE (is_default) WHERE is_default = 1`, which is a rule about the shop
 * enforced against one file — so two counters offline each chose a default quite
 * legitimately, and the second row to arrive anywhere raised a unique failure.
 * One value in one row has exactly one answer and needs no constraint to say so.
 *
 * Here rather than beside `defaultPriceListId`, because that one lives in
 * `repos/pricing.ts` and already reads settings from this file. A key that both
 * of them import has to sit on the side of that line they can both reach.
 */
export const DEFAULT_PRICE_LIST = 'default_price_list_id'

export async function setSetting(db: SqlDriver, key: string, value: string, now?: string): Promise<void> {
  const updatedAt = now ?? new Date().toISOString()
  await q(db).insert(schema.settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt } })
}

/**
 * Removes a setting from the shared table.
 *
 * Used for the keys that were never the shop's business — which counter this
 * machine is, what printer is plugged into it, what command carries its backup
 * away. See `deviceSettings.ts` for the order those have to be moved in, which
 * is the part that is easy to get wrong.
 */
export async function forgetSetting(db: SqlDriver, key: string): Promise<void> {
  await q(db).delete(schema.settings).where(eq(schema.settings.key, key))
}

export async function getSetting(db: SqlDriver, key: string): Promise<string | null> {
  const [row] = await q(db)
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
  return row?.value ?? null
}
