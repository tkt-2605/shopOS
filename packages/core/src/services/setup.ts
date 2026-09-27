import { eq, isNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { SUBMITTED } from '../integrity/docstatus.js'
import { getSetting, setSetting, forgetSetting } from './settings.js'
import { taxSchemeAnswered } from './features.js'
import { loadShopProfile } from './shop.js'

/**
 * How far a new shop has got with setting itself up.
 *
 * The first start asks for a name and a password and nothing else, which is
 * right -- a shop must be able to ring up a sale in the first minute -- but it
 * leaves the things that make a bill *correct* to be discovered one wrong
 * invoice at a time: a shop with no state code taxes every sale as local, and
 * one that never said whether it is registered prints the wrong heading.
 *
 * So each step is a fact read from the shop's own data, never a box somebody
 * ticked. A step is done when the thing is done, however it was done, and a
 * shop that set its GSTIN from Settings on day one never sees it asked.
 *
 * These are the shop's steps, the same on every till. What belongs to one
 * machine -- its printer, where its backups go -- is added by the app, which
 * holds those settings.
 */

export type ShopStep = 'shopDetails' | 'taxScheme' | 'items' | 'openingStock' | 'staff' | 'firstBill'

export type ShopProgress = Record<ShopStep, boolean>

const HIDDEN = 'setup_checklist_hidden'

export async function shopProgress(db: SqlDriver): Promise<ShopProgress> {
  const shop = await loadShopProfile(db)
  const n = sql<number>`count(*)`
  const [items] = await q(db).select({ n }).from(schema.products).where(isNull(schema.products.deletedAt))
  const [moved] = await q(db).select({ id: schema.stockLedger.id }).from(schema.stockLedger).limit(1)
  const [staff] = await q(db).select({ n }).from(schema.users).where(eq(schema.users.isActive, 1))
  const [bills] = await q(db).select({ n }).from(schema.bills).where(eq(schema.bills.docstatus, SUBMITTED))

  return {
    // A bill prints the address, and the state decides CGST and SGST against IGST.
    shopDetails: Boolean(shop.address?.trim()) && Boolean(shop.stateCode),
    taxScheme: await taxSchemeAnswered(db),
    items: Number(items?.n ?? 0) > 0,
    openingStock: moved !== undefined,
    // The administrator made at first start is one; a cashier of their own is two.
    staff: Number(staff?.n ?? 0) > 1,
    firstBill: Number(bills?.n ?? 0) > 0,
  }
}

/** Whether somebody has put the list away. Shared, so it goes from every till at once. */
export async function setupHidden(db: SqlDriver): Promise<boolean> {
  return (await getSetting(db, HIDDEN)) === 'yes'
}

export async function hideSetup(db: SqlDriver, hidden: boolean): Promise<void> {
  if (hidden) await setSetting(db, HIDDEN, 'yes')
  else await forgetSetting(db, HIDDEN)
}
