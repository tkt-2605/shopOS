import type { SqlDriver } from '../db/driver.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { getSetting, setSetting } from './bootstrap.js'
import type { Rounding } from '../domain/billTotals.js'

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
}

export type FeatureKey = keyof Features

const SETTING: Record<FeatureKey, string> = {
  multiBarcode: 'feature_multi_barcode',
  tieredPricing: 'feature_tiered_pricing',
  uniquePhone: 'feature_unique_phone',
}

const LABEL: Record<FeatureKey, string> = {
  multiBarcode: 'Several barcodes per item',
  tieredPricing: 'Quantity price breaks',
  uniquePhone: 'One customer per phone number',
}

/**
 * Off is the answer for a shop that has never said. Migration 011 turned each
 * one on for a shop whose data already showed it in use, so "never said" really
 * does mean never used.
 */
export const FEATURES_OFF: Features = {
  multiBarcode: false, tieredPricing: false, uniquePhone: false,
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
