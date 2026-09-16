import type { SqlDriver, SqlValue } from '../db/driver.js'
import { newId } from '../ids.js'
import { type Money, ZERO, paise } from '../money.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
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
  const owed = await db.get<{ due: number }>(
    `SELECT COALESCE(SUM(b.credit_total), 0)
          - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                        JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
                        JOIN bills b2 ON b2.id = pa.bill_id
                       WHERE b2.customer_id = ?), 0) AS due
       FROM bills b WHERE b.customer_id = ? AND b.docstatus = 1`,
    [customerId, customerId],
  )
  const outstanding = paise(Math.max(0, owed?.due ?? 0))
  if (outstanding > 0) return { ok: false, code: 'OWES_MONEY', outstanding }

  const now = ctx.now?.() ?? new Date().toISOString()
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE customers SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
      [now, now, customerId],
    )
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
    await tx.execute(
      `UPDATE customers SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL`,
      [now, customerId],
    )
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
  const row = await db.get<{ id: string; code: string | null; name: string; phone: string | null }>(
    `SELECT id, code, name, phone FROM customers
      WHERE phone = ? AND deleted_at IS NULL AND (? IS NULL OR id <> ?)
      ORDER BY created_at LIMIT 1`,
    [trimmed, exceptId, exceptId],
  )
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
    const clash = await db.get<{ id: string; code: string | null; name: string; phone: string | null }>(
      `SELECT id, code, name, phone FROM customers
        WHERE code = ? AND deleted_at IS NULL AND (? IS NULL OR id <> ?)`,
      [wanted, customerId, customerId],
    )
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

  const before = customerId
    ? await db.get<Record<string, SqlValue>>(
      `SELECT code, name, phone, email, gstin, address, state_code,
              credit_limit, credit_enforcement, is_active
         FROM customers WHERE id = ?`, [customerId],
    )
    : null

  const id = customerId ?? newId()
  const code = wanted ?? (before?.['code'] as string | null) ?? await nextCustomerCode(db)

  await db.transaction(async (tx) => {
    if (customerId) {
      await tx.execute(
        `UPDATE customers SET code = ?, name = ?, phone = ?, email = ?, gstin = ?, address = ?,
                state_code = ?, credit_limit = ?, credit_enforcement = ?, is_active = ?,
                updated_at = ?, rev = rev + 1
          WHERE id = ?`,
        [code, name, phone, input.email?.trim() || null, gstin,
         input.address?.trim() || null, stateCode, limit, enforcement, active, now, customerId],
      )
    } else {
      await tx.execute(
        `INSERT INTO customers
           (id, code, name, phone, email, gstin, address, credit_limit, credit_enforcement,
            is_active, state_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, code, name, phone, input.email?.trim() || null, gstin,
         input.address?.trim() || null, limit, enforcement, active, stateCode, now, now],
      )
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
  const row = await db.get<{ highest: number | null }>(
    `SELECT MAX(CAST(substr(code, 2) AS INTEGER)) AS highest
       FROM customers
      WHERE code GLOB 'C[0-9]*' AND substr(code, 2) GLOB '[0-9]*'`,
  )

  let next = (row?.highest ?? 0) + 1
  for (;;) {
    const code = `C${String(next).padStart(4, '0')}`
    const taken = await db.get<{ id: string }>(`SELECT id FROM customers WHERE code = ?`, [code])
    if (!taken) return code
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
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM customers WHERE code IS NULL AND deleted_at IS NULL ORDER BY created_at`,
  )
  let given = 0
  for (const row of rows) {
    const code = await nextCustomerCode(db)
    await db.execute(`UPDATE customers SET code = ? WHERE id = ? AND code IS NULL`, [code, row.id])
    given += 1
  }
  return given
}
