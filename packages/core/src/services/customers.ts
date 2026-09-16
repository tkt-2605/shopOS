import { eq, ne, and, isNull, isNotNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { type Money, ZERO, paise } from '../money.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { SUBMITTED } from '../integrity/docstatus.js'
import { isOn } from './features.js'
import { getSetting } from './bootstrap.js'
import { isGstin, resolveCustomerState, stateFromGstin } from '../domain/gstin.js'
import { isStateCode } from '../domain/states.js'
import type { CreditEnforcement } from '../domain/credit.js'

/**
 * Who the shop's customers are.
 *
 * This existed as two `db.execute` calls inside the customers screen, which is
 * why the same person could be entered three times on one phone number: there
 * was no layer that could say no. Nothing was audited either, so a credit limit
 * could change and the history page had nothing to show.
 *
 * Two identities, doing different jobs:
 *
 *   - **The code** is the shop's own reference — C0001, or whatever the owner
 *     already writes in their book. Unique, always, and generated when nobody
 *     supplies one, because an identifier a shop has to invent by hand is an
 *     identifier that stays empty.
 *   - **The phone** is how a customer is actually found at the counter. Whether
 *     two people may share one is a decision the shop makes: a household with
 *     one phone and two khata accounts is real, and so is the same person
 *     entered twice by a tired cashier. See the `uniquePhone` switch.
 */

export interface CustomerInput {
  name: string
  code?: string | null
  phone?: string | null
  email?: string | null
  gstin?: string | null
  address?: string | null
  /**
   * Which state they are in, which is what decides CGST+SGST against IGST.
   *
   * Optional because the counter should not stop for it: left out, it is
   * derived from the GSTIN when there is one and otherwise defaults to the
   * shop's own state, which for a walk-in is right far more often than it is
   * wrong. What it may never again be is the literal `'33'` this INSERT used to
   * carry, which made every customer in every shop a Tamil Nadu customer.
   */
  stateCode?: string | null
  creditLimit?: Money
  creditEnforcement?: CreditEnforcement
  isActive?: boolean
}

export interface CustomerConflict {
  id: string
  code: string | null
  name: string
  phone: string | null
}

/** The four fields a screen needs to offer "open that customer instead". */
const conflictShape = {
  id: schema.customers.id,
  code: schema.customers.code,
  name: schema.customers.name,
  phone: schema.customers.phone,
}

export type SaveCustomerResult =
  | { ok: true; customerId: string; code: string }
  | { ok: false; code: 'NAME_REQUIRED' }
  /** Somebody already answers to this phone, and this shop has said that is not allowed. */
  | { ok: false; code: 'PHONE_TAKEN'; existing: CustomerConflict }
  | { ok: false; code: 'CODE_TAKEN'; existing: CustomerConflict }
  /** Fifteen characters in the shape the government issues. The checksum is not checked. */
  | { ok: false; code: 'BAD_GSTIN' }
  | { ok: false; code: 'UNKNOWN_STATE' }
  /**
   * The GSTIN says one state and the form says another. Caught at the counter,
   * where it is a typo, rather than at filing time where it is a correction to
   * a return.
   */
  | { ok: false; code: 'GSTIN_STATE_MISMATCH'; gstinState: string; chosenState: string }

export async function createCustomer(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: CustomerInput,
): Promise<SaveCustomerResult> {
  return save(db, ctx, null, input)
}

export async function updateCustomer(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  customerId: string,
  input: CustomerInput,
): Promise<SaveCustomerResult> {
  return save(db, ctx, customerId, input)
}

export type ArchiveCustomerResult =
  | { ok: true }
  /**
   * They still owe money, so hiding them would hide the khata.
   *
   * The whole point of archiving is that they stop appearing in searches — and
   * a balance nobody can find is a debt the shop has written off without
   * deciding to. Settle it, or write it off on purpose, and then archive them.
   */
  | { ok: false; code: 'OWES_MONEY'; outstanding: Money }

/**
 * A customer who has stopped coming.
 *
 * `customers.deleted_at` has been filtered by `searchCustomers`, by the pricing
 * lookup and by the credit report since they were written, and nothing has ever
 * set it. A shop whose list had filled up with one-off walk-ins, duplicates and
 * people who moved away could do nothing about any of them.
 *
 * Archived, never deleted. Every bill they were ever issued names them, their
 * loyalty points are theirs, and the khata is a record of money that changed
 * hands. What archiving does is take them out of the searches — the counter's
 * customer picker and the customer list — and nothing else.
 */
export async function archiveCustomer(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  customerId: string,
): Promise<ArchiveCustomerResult> {
  /* Billed on credit, less what has been paid against those bills. It was one
     statement with the second half as a correlated subquery; it is two now,
     because a subtraction of two sums reads as a subtraction of two sums. Both
     are outside a transaction either way, so nothing is being held open that
     was not before. */
  const [billed] = await q(db)
    .select({ total: sql<Money>`COALESCE(SUM(${schema.bills.creditTotal}), 0)` })
    .from(schema.bills)
    .where(and(eq(schema.bills.customerId, customerId), eq(schema.bills.docstatus, SUBMITTED)))

  const [paid] = await q(db)
    .select({ total: sql<Money>`COALESCE(SUM(${schema.paymentAllocations.amount}), 0)` })
    .from(schema.paymentAllocations)
    .innerJoin(schema.paymentEntries, and(
      eq(schema.paymentEntries.id, schema.paymentAllocations.paymentId),
      eq(schema.paymentEntries.docstatus, SUBMITTED),
    ))
    .innerJoin(schema.bills, eq(schema.bills.id, schema.paymentAllocations.billId))
    .where(eq(schema.bills.customerId, customerId))

  const outstanding = paise(Math.max(0, (billed?.total ?? 0) - (paid?.total ?? 0)))
  if (outstanding > 0) return { ok: false, code: 'OWES_MONEY', outstanding }

  const now = ctx.now?.() ?? new Date().toISOString()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.customers)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt)))
    await writeAudit(tx, ctx, { entity: 'customers', entityId: customerId, action: 'delete' })
  })
  return { ok: true }
}

/** Back into the searches, exactly as they were. */
export async function restoreCustomer(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  customerId: string,
): Promise<void> {
  const now = ctx.now?.() ?? new Date().toISOString()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.customers)
      .set({ deletedAt: null, updatedAt: now })
      .where(and(eq(schema.customers.id, customerId), isNotNull(schema.customers.deletedAt)))
    await writeAudit(tx, ctx, { entity: 'customers', entityId: customerId, action: 'update',
      after: { Archived: 'no' } })
  })
}

/**
 * Who else has this number.
 *
 * Asked by the screen as the number is typed, so the answer arrives before the
 * save rather than as a refusal afterwards — and so the cashier can open that
 * customer instead of entering them again, which is the actual fix.
 */
export async function customerByPhone(
  db: SqlDriver,
  phone: string,
  exceptId: string | null = null,
): Promise<CustomerConflict | null> {
  const trimmed = phone.trim()
  if (trimmed === '') return null

  /* The "except this one" test was `(? IS NULL OR id <> ?)`, which bound the
     same value twice and left SQLite to work out that the condition was not
     there. Here it is either in the list or it is not. */
  const [row] = await q(db)
    .select(conflictShape)
    .from(schema.customers)
    .where(and(
      eq(schema.customers.phone, trimmed),
      isNull(schema.customers.deletedAt),
      ...(exceptId === null ? [] : [ne(schema.customers.id, exceptId)]),
    ))
    .orderBy(schema.customers.createdAt)
    .limit(1)
  return row ?? null
}

async function save(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  customerId: string | null,
  input: CustomerInput,
): Promise<SaveCustomerResult> {
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NAME_REQUIRED' }

  const phone = (input.phone ?? '').trim() || null

  if (phone !== null && await isOn(db, 'uniquePhone')) {
    const clash = await customerByPhone(db, phone, customerId)
    if (clash) return { ok: false, code: 'PHONE_TAKEN', existing: clash }
  }

  const wanted = (input.code ?? '').trim() || null
  if (wanted !== null) {
    const [clash] = await q(db)
      .select(conflictShape)
      .from(schema.customers)
      .where(and(
        eq(schema.customers.code, wanted),
        isNull(schema.customers.deletedAt),
        ...(customerId === null ? [] : [ne(schema.customers.id, customerId)]),
      ))
    // The code is the shop's own reference and two customers sharing one makes
    // it useless, so this is refused whatever the phone switch says.
    if (clash) return { ok: false, code: 'CODE_TAKEN', existing: clash }
  }

  const gstin = input.gstin?.trim().toUpperCase() || null
  if (gstin !== null && !isGstin(gstin)) return { ok: false, code: 'BAD_GSTIN' }

  const chosen = input.stateCode?.trim() || null
  if (chosen !== null && !isStateCode(chosen)) return { ok: false, code: 'UNKNOWN_STATE' }

  const fromGstin = stateFromGstin(gstin)
  if (fromGstin !== null && chosen !== null && fromGstin !== chosen) {
    return { ok: false, code: 'GSTIN_STATE_MISMATCH', gstinState: fromGstin, chosenState: chosen }
  }

  /* The shop's own state, as the default for somebody who has not said. A
     counter shop's customers are overwhelmingly local, and the alternative --
     leaving it null -- reads as inter-state nowhere and as "unknown place of
     supply" on the invoice. `resolveCustomerState` carries the order. */
  const stateCode = resolveCustomerState({
    gstin, chosen, shopState: await getSetting(db, 'shop_state_code'),
  })

  const now = ctx.now?.() ?? new Date().toISOString()
  const limit = input.creditLimit ?? ZERO
  const enforcement = input.creditEnforcement ?? 'hard'
  const active = input.isActive === false ? 0 : 1

  const [before] = customerId
    ? await q(db)
      .select({
        code: schema.customers.code,
        name: schema.customers.name,
        phone: schema.customers.phone,
        email: schema.customers.email,
        gstin: schema.customers.gstin,
        address: schema.customers.address,
        state_code: schema.customers.stateCode,
        credit_limit: schema.customers.creditLimit,
        credit_enforcement: schema.customers.creditEnforcement,
        is_active: schema.customers.isActive,
      })
      .from(schema.customers)
      .where(eq(schema.customers.id, customerId))
    : [null]

  const id = customerId ?? newId()
  const code = wanted ?? before?.code ?? await nextCustomerCode(db)

  /* The two statements wrote the same ten fields in two different orders, each
     with its own list of placeholders to keep in step. One object now, used by
     both. */
  const fields = {
    code,
    name,
    phone,
    email: input.email?.trim() || null,
    gstin,
    address: input.address?.trim() || null,
    stateCode,
    creditLimit: limit,
    creditEnforcement: enforcement,
    isActive: active,
    updatedAt: now,
  }

  await db.transaction(async (tx) => {
    if (customerId) {
      await q(tx).update(schema.customers)
        .set({ ...fields, rev: sql`${schema.customers.rev} + 1` })
        .where(eq(schema.customers.id, customerId))
    } else {
      await q(tx).insert(schema.customers).values({ ...fields, id, createdAt: now })
    }

    await writeAudit(tx, ctx, {
      entity: 'customers',
      entityId: id,
      action: customerId ? 'update' : 'create',
      before: before ?? {},
      after: {
        code, name, phone,
        gstin, state_code: stateCode,
        credit_limit: limit,
        credit_enforcement: enforcement,
        is_active: active,
      },
    })
  })

  return { ok: true, customerId: id, code }
}

/**
 * The next free code in the shop's own series.
 *
 * Counted from the highest C-number rather than from how many customers there
 * are, so deleting one does not hand its number to the next person. The loop is
 * the guard against a shop that has typed its own codes by hand and happens to
 * already own the next one.
 */
export async function nextCustomerCode(db: SqlDriver): Promise<string> {
  const code = schema.customers.code

  /* raw: two `GLOB`s and a `CAST`, which a query builder has no words for. The
     second one is not redundant: `C1A` matches the first pattern, and casting
     it gives 1, which would hand C0002 to somebody who already has it. */
  const [row] = await q(db)
    .select({ highest: sql<number | null>`MAX(CAST(substr(${code}, 2) AS INTEGER))` })
    .from(schema.customers)
    .where(sql`${code} GLOB 'C[0-9]*' AND substr(${code}, 2) GLOB '[0-9]*'`)

  let next = (row?.highest ?? 0) + 1
  for (;;) {
    const candidate = `C${String(next).padStart(4, '0')}`
    const [taken] = await q(db)
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(code, candidate))
    if (!taken) return candidate
    next += 1
  }
}

/**
 * Gives a code to every customer that has none.
 *
 * Run at start-up rather than in a migration: the codes have to dodge whatever
 * the shop has already typed by hand, and a migration that hit a unique
 * constraint would leave the shop unable to open its own till. Here the worst
 * case is that one customer keeps waiting for a code.
 */
export async function backfillCustomerCodes(db: SqlDriver): Promise<number> {
  const rows = await q(db)
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(and(isNull(schema.customers.code), isNull(schema.customers.deletedAt)))
    .orderBy(schema.customers.createdAt)

  let given = 0
  for (const row of rows) {
    const code = await nextCustomerCode(db)
    await q(db).update(schema.customers)
      .set({ code })
      .where(and(eq(schema.customers.id, row.id), isNull(schema.customers.code)))
    given += 1
  }
  return given
}
