import { eq, and, gt } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { ZERO } from '../money.js'
import { SUBMITTED } from '../integrity/docstatus.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { getSetting, setSetting } from './settings.js'
import type { Rounding } from '../domain/billTotals.js'
import { defaultScheme, isTaxScheme, type TaxScheme } from '../domain/taxScheme.js'

/**
 * The capabilities a shop has chosen to use.
 *
 * Not everything built belongs on every counter. A shop with one printed tag per
 * item does not want a barcode list, and a shop that sells everything at one
 * price does not want a quantity ladder on every product form. Both are a real
 * cost — a box a worker can get wrong is worse than a box that is not there.
 *
 * Two rules make these switches safe to flick:
 *
 *   - **Nothing is deleted.** Turning a feature off hides its editor; the rows
 *     stay, and turning it back on finds them where they were.
 *   - **A scan never gets worse.** Extra barcodes go on finding their item at the
 *     counter whatever this says. The switch is about what a person is asked to
 *     fill in, not about refusing to recognise a code the shop has already
 *     printed and stuck on a shelf.
 *
 * Quantity breaks are the exception to the first rule in one direction only: a
 * ladder that is switched off must stop changing prices, or a shop would turn it
 * off and go on being billed by it. What happens instead is written down on
 * `resolvePrice` — the first rung becomes the price, at any quantity.
 */

export interface Features {
  /** Several barcodes on one item. */
  multiBarcode: boolean
  /** Cheaper by the quantity: 1=₹15, 10=₹12. */
  tieredPricing: boolean
  /**
   * One customer per phone number.
   *
   * On, a number already in use is refused and the screen offers to open the
   * customer who has it — which is what a cashier entering the same person for
   * the third time actually wants. Off, the same warning appears and the save is
   * allowed, for the household with one phone and two khata accounts.
   *
   * Enforced in the service rather than by a unique index on purpose: a shop
   * that already has duplicates must not be locked out of its own database, and
   * a constraint cannot be switched off.
   */
  uniquePhone: boolean
  /**
   * Batch numbers and expiry dates.
   *
   * On, a stock entry asks for the batch and expiry of each line, the counter
   * shows which batch a sale comes out of and lets the cashier pick another,
   * and Inventory lists what is about to expire. Off, none of those are asked
   * or shown -- but a sale of an item that already has batches still comes out
   * of them, so that switching back on finds every balance right. See
   * `services/batches.ts`.
   */
  batchExpiry: boolean
}

export type FeatureKey = keyof Features

const SETTING: Record<FeatureKey, string> = {
  multiBarcode: 'feature_multi_barcode',
  tieredPricing: 'feature_tiered_pricing',
  uniquePhone: 'feature_unique_phone',
  batchExpiry: 'feature_batch_expiry',
}

const LABEL: Record<FeatureKey, string> = {
  multiBarcode: 'Several barcodes per item',
  tieredPricing: 'Quantity price breaks',
  uniquePhone: 'One customer per phone number',
  batchExpiry: 'Batch numbers and expiry dates',
}

/**
 * Off is the answer for a shop that has never said. Migration 011 turned each
 * one on for a shop whose data already showed it in use, so "never said" really
 * does mean never used.
 */
export const FEATURES_OFF: Features = {
  multiBarcode: false, tieredPricing: false, uniquePhone: false, batchExpiry: false,
}

export async function loadFeatures(db: SqlDriver): Promise<Features> {
  const keys = Object.keys(SETTING) as FeatureKey[]
  const values = await Promise.all(keys.map((key) => getSetting(db, SETTING[key])))
  // Built from the record rather than destructured, so adding a switch is three
  // lines above this and nothing here.
  return Object.fromEntries(keys.map((key, i) => [key, values[i] === 'on'])) as unknown as Features
}

export async function isOn(db: SqlDriver, key: FeatureKey): Promise<boolean> {
  return (await getSetting(db, SETTING[key])) === 'on'
}

/** Audited, because "the prices changed and nobody touched a price" needs an answer. */
export async function setFeature(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  key: FeatureKey,
  on: boolean,
): Promise<void> {
  const before = await getSetting(db, SETTING[key])
  const after = on ? 'on' : 'off'
  if (before === after) return

  await db.transaction(async (tx) => {
    await setSetting(tx, SETTING[key], after, ctx.now?.())
    await writeAudit(tx, ctx, {
      entity: 'settings',
      entityId: SETTING[key],
      action: 'update',
      before: { [LABEL[key]]: before ?? 'off' },
      after: { [LABEL[key]]: after },
    })
  })
}


/* ------------------------------------------------------ selling short --- */

/**
 * What the counter does when the count says there is nothing left.
 *
 * Not a switch, because there are three honest answers and only one of them was
 * ever available. Until now the till simply refused, which is defensible for the
 * books and useless at a counter: every shop's opening counts are wrong, so in
 * week one a customer is holding a pen the records say does not exist and the
 * cashier's only way forward is to not bill it. That is how a shop learns to
 * keep a paper book beside this product.
 *
 *   - `block` — refuse the sale. Right for a pharmacy, or anywhere the count is
 *     the point.
 *   - `warn` — say so, and let the cashier go on. The default, and what the
 *     shortfall report exists to clean up after.
 *   - `allow` — say nothing. Fastest, and a genuine error is never noticed.
 *
 * Whatever is chosen, the goods still leave at a cost and the item still turns
 * up on the shortfall report. The setting governs the counter, not the books.
 */
export type StockPolicy = 'block' | 'warn' | 'allow'

const STOCK_POLICY = 'stock_policy'

const POLICIES: readonly StockPolicy[] = ['block', 'warn', 'allow']

export const STOCK_POLICY_DEFAULT: StockPolicy = 'warn'

export async function loadStockPolicy(db: SqlDriver): Promise<StockPolicy> {
  const value = await getSetting(db, STOCK_POLICY)
  return POLICIES.includes(value as StockPolicy) ? (value as StockPolicy) : STOCK_POLICY_DEFAULT
}

export async function setStockPolicy(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  policy: StockPolicy,
): Promise<void> {
  const before = await loadStockPolicy(db)
  if (before === policy) return

  await db.transaction(async (tx) => {
    await setSetting(tx, STOCK_POLICY, policy, ctx.now?.())
    await writeAudit(tx, ctx, {
      entity: 'settings',
      entityId: STOCK_POLICY,
      action: 'update',
      before: { 'Selling below the count': before },
      after: { 'Selling below the count': policy },
    })
  })
}

/**
 * What the counter does with the last few paise.
 *
 * `bills.round_off` has been a column since migration 001 and the reports have
 * summed it since they were written; nothing ever put a number in it. This is
 * what fills it. The arithmetic and the reasoning are in `billTotals.ts` —
 * here is only the shop's answer, and the default is the honest one: `none`,
 * which charges what the bill comes to.
 */
const ROUNDING = 'round_off_rule'

const RULES: readonly Rounding[] = ['none', 'nearest', 'up', 'down']

export const ROUNDING_DEFAULT: Rounding = 'none'

export async function loadRounding(db: SqlDriver): Promise<Rounding> {
  const value = await getSetting(db, ROUNDING)
  return RULES.includes(value as Rounding) ? (value as Rounding) : ROUNDING_DEFAULT
}

export async function setRounding(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  rule: Rounding,
): Promise<void> {
  const before = await loadRounding(db)
  if (before === rule) return

  await db.transaction(async (tx) => {
    await setSetting(tx, ROUNDING, rule, ctx.now?.())
    await writeAudit(tx, ctx, {
      entity: 'settings',
      entityId: ROUNDING,
      action: 'update',
      before: { 'Rounding the total': before },
      after: { 'Rounding the total': rule },
    })
  })
}

/**
 * Which GST scheme the shop is under.
 *
 * The rules and the reasoning are in `domain/taxScheme.ts`. Here is only where
 * the answer is kept, and what happens before anybody has given one.
 *
 * Absent means unanswered, and an unanswered shop is *derived* from whether it
 * has a GSTIN, every time it is asked, rather than having a default written in
 * once by a migration. A shop that enters its GSTIN next week stops being
 * treated as unregistered without anybody having to remember this setting
 * exists — and `taxSchemeAnswered` is how Settings knows to ask.
 */
const TAX_SCHEME = 'shop_tax_scheme'

export async function loadTaxScheme(db: SqlDriver): Promise<TaxScheme> {
  const stored = await getSetting(db, TAX_SCHEME)
  if (isTaxScheme(stored)) return stored

  const gstin = await getSetting(db, 'shop_gstin')
  if (defaultScheme(gstin) === 'regular') return 'regular'

  /* No GSTIN is not evidence of not being registered.
   *
   * Until `services/shop.ts` was written there was no screen in this product
   * that could save one -- the field was read by the receipt, the statement and
   * every bill, and written nowhere. So a shop that has been trading for a year
   * and is properly registered has an empty `shop_gstin` for reasons that are
   * this software's fault and say nothing about the shop.
   *
   * What does say something is what the shop has been doing. A till with
   * submitted bills carrying tax has been operating as a registered shop, by a
   * person who meant to. Reading a missing field as "not registered" and
   * silently switching that shop's tax off on upgrade would leave it owing
   * output tax on every sale it made afterwards -- money it has to find out of
   * its own takings, because the customer is long gone.
   *
   * So the behaviour is preserved and Settings asks. The owner's own database
   * is exactly this case: 29 submitted bills, every one carrying CGST and SGST,
   * and no GSTIN anywhere (`findings-real-shop.md`, finding 2).
   *
   * A till that has never charged tax has nothing to preserve, and there the
   * safe reading is the one that does not collect tax in a shop's name without
   * being told it may. */
  const [charged] = await q(db)
    .select({ id: schema.bills.id })
    .from(schema.bills)
    .where(and(eq(schema.bills.docstatus, SUBMITTED), gt(schema.bills.taxTotal, ZERO)))
    .limit(1)
  return charged ? 'regular' : 'unregistered'
}

/** Whether a person has said, as opposed to the till having worked it out. */
export async function taxSchemeAnswered(db: SqlDriver): Promise<boolean> {
  return isTaxScheme(await getSetting(db, TAX_SCHEME))
}

export async function setTaxScheme(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  scheme: TaxScheme,
): Promise<void> {
  const before = await loadTaxScheme(db)
  const answered = await taxSchemeAnswered(db)
  // Written even when it matches what was derived: answering the question is
  // itself the change, and it is what stops the till asking again.
  if (answered && before === scheme) return

  await db.transaction(async (tx) => {
    await setSetting(tx, TAX_SCHEME, scheme, ctx.now?.())
    await writeAudit(tx, ctx, {
      entity: 'settings',
      entityId: TAX_SCHEME,
      action: 'update',
      before: { 'GST scheme': answered ? before : `${before} (assumed)` },
      after: { 'GST scheme': scheme },
    })
  })
}
