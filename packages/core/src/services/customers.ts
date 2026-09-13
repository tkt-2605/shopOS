import type { SqlDriver, SqlValue } from '../db/driver.js'
import { newId } from '../ids.js'
import { type Money, ZERO } from '../money.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { isOn } from './features.js'
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

  const now = ctx.now?.() ?? new Date().toISOString()
  const limit = input.creditLimit ?? ZERO
  const enforcement = input.creditEnforcement ?? 'hard'
  const active = input.isActive === false ? 0 : 1

  const before = customerId
    ? await db.get<Record<string, SqlValue>>(
      `SELECT code, name, phone, email, gstin, address, credit_limit, credit_enforcement, is_active
         FROM customers WHERE id = ?`, [customerId],
    )
    : null

  const id = customerId ?? newId()
  const code = wanted ?? (before?.['code'] as string | null) ?? await nextCustomerCode(db)

  await db.transaction(async (tx) => {
    if (customerId) {
      await tx.execute(
        `UPDATE customers SET code = ?, name = ?, phone = ?, email = ?, gstin = ?, address = ?,
                credit_limit = ?, credit_enforcement = ?, is_active = ?,
                updated_at = ?, rev = rev + 1
          WHERE id = ?`,
        [code, name, phone, input.email?.trim() || null, input.gstin?.trim() || null,
         input.address?.trim() || null, limit, enforcement, active, now, customerId],
      )
    } else {
      await tx.execute(
        `INSERT INTO customers
           (id, code, name, phone, email, gstin, address, credit_limit, credit_enforcement,
            is_active, state_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '33', ?, ?)`,
        [id, code, name, phone, input.email?.trim() || null, input.gstin?.trim() || null,
         input.address?.trim() || null, limit, enforcement, active, now, now],
      )
    }

    await writeAudit(tx, ctx, {
      entity: 'customers',
      entityId: id,
      action: customerId ? 'update' : 'create',
      before: before ?? {},
      after: {
        code, name, phone,
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
