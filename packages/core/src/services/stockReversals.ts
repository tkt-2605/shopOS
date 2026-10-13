import type { SqlDriver } from '../db/driver.js'
import { applyingRemote } from './changefeed.js'

/**
 * A document cancelled on two tills while apart takes its stock back once.
 *
 * Cancelling posts a reversing movement for each movement the document made,
 * under a fresh id. The books do not have this problem -- their ids are derived
 * from the document, so two tills reversing one bill write the same rows and
 * the union holds one set. Stock ids are not derived: they are the order the
 * movements were made in (`MADE`), and a reversal has to sort where it was
 * made, so two tills each mint their own. After the merge the ledger holds two
 * reversals of one sale, the shelf is a unit too high, and the stock account
 * differs from the books by exactly that unit's cost.
 *
 * The ledger is append-only, so the extra reversal is not removed. It is
 * answered with a movement of its own that takes it back, and its id is derived
 * from the row it answers. Every till that holds both reversals therefore
 * writes the same row, and writes it as a merge does -- without the change feed
 * -- because each derives the same answer from the same rows and a row relayed
 * to a till that has already made it would only be a second copy to quarantine.
 *
 * Which reversals are the extra ones: a till that cancels a document writes one
 * whole set of reversals for it, under its own `device_id` (060), and no till
 * cancels one document twice. So where reversals of one document and product
 * come from two tills, the set from the lower device id stays and every other
 * is taken back. That is decided from the reversals alone -- each one says who
 * made it -- so it comes out the same on every till whatever order the rows
 * arrived in.
 *
 * It used to be decided by counting: the reversals beyond the number of
 * original movements, latest id first out. A reversal that arrived before the
 * sale it reverses -- which a feed re-seeded below its floor sends every time,
 * because the sale was pruned and is appended after it -- was counted against
 * nothing and taken back, and the sale then left the shelf for good on that
 * till alone. Counting is kept only for reversals from before 060, which carry
 * no device, and never judges a document whose sale has not arrived.
 */

/** What a reversal is of, for the documents that reverse stock. */
const REVERSED = ['bill', 'sales_return', 'stock_entry'] as const

/** The voucher type a taken-back reversal is filed under: not one of the reversals above. */
const VOIDED = (type: string) => `${type}_voided`

export interface DoubleReversal {
  /** The reversal that is one too many. */
  movementId: string
  productId: string
  voucherType: string
  voucherId: string
  qtyChange: number
}

interface Row {
  id: string
  product_id: string
  qty_change: number
  unit_cost: number | null
  value_change: number | null
  voucher_type: string
  voucher_id: string
  posting_date: string
  created_by: string | null
  device_id: string | null
}

/** Enough placeholders per statement to stay well under SQLite's limit. */
const CHUNK = 400

/**
 * Every reversal that has no movement to answer for it, and, with `repair`,
 * each one taken back. `voucherIds` scopes it to the documents a batch touched;
 * null or absent means every document.
 */
export async function reconcileDoubleReversals(
  db: SqlDriver,
  opts: { repair?: boolean; voucherIds?: readonly string[] | null } = {},
): Promise<DoubleReversal[]> {
  const scope = opts.voucherIds ?? null
  if (scope !== null && scope.length === 0) return []

  const excess: Row[] = []
  for (let i = 0; i < (scope?.length ?? 1); i += CHUNK) {
    const ids = scope === null ? null : scope.slice(i, i + CHUNK)
    excess.push(...await excessAmong(db, ids))
  }
  if (excess.length === 0) return []

  if (opts.repair) {
    await applyingRemote(db, async (tx) => {
      for (const r of excess) await takeBack(tx, r)
    })
  }

  return excess.map((r) => ({
    movementId: r.id, productId: r.product_id, voucherType: r.voucher_type,
    voucherId: r.voucher_id, qtyChange: r.qty_change,
  }))
}

async function excessAmong(db: SqlDriver, vouchers: readonly string[] | null): Promise<Row[]> {
  const kinds = REVERSED.map((t) => `${t}_reversal`)
  const where = vouchers === null ? '' : ` AND r.voucher_id IN (${vouchers.map(() => '?').join(', ')})`
  // raw: one pass over the reversals of the documents in scope, answered
  // against their original movements and the takings-back already written.
  const reversals = await db.query<Row>(
    `SELECT r.id, r.product_id, r.qty_change, r.unit_cost, r.value_change, r.voucher_type,
            r.voucher_id, r.posting_date, r.created_by, r.device_id
       FROM stock_ledger r
      WHERE r.voucher_type IN (${kinds.map(() => '?').join(', ')})${where}
        AND NOT EXISTS (SELECT 1 FROM stock_ledger v WHERE v.id = r.id || '~dup')
      ORDER BY r.voucher_id, r.product_id, r.id`,
    [...kinds, ...(vouchers ?? [])],
  )
  if (reversals.length === 0) return []

  // One document and product at a time. Reversals already taken back are not
  // here: they were the extra ones.
  const groups = new Map<string, Row[]>()
  for (const r of reversals) {
    const key = `${r.voucher_type}\u0000${r.voucher_id}\u0000${r.product_id}`
    const group = groups.get(key)
    if (group) group.push(r)
    else groups.set(key, [r])
  }

  const out: Row[] = []
  for (const rows of groups.values()) {
    const devices = rows.map((r) => r.device_id)
    if (devices.every((d): d is string => d !== null)) {
      const keep = devices.reduce((lowest, d) => (d < lowest ? d : lowest))
      out.push(...rows.filter((r) => r.device_id !== keep))
      continue
    }

    /* From before 060: by count, and only once the sale is here to count. */
    const first = rows[0]!
    const original = first.voucher_type.slice(0, -'_reversal'.length)
    // raw: a count by document and product.
    const [n] = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_ledger
        WHERE voucher_type = ? AND voucher_id = ? AND product_id = ?`,
      [original, first.voucher_id, first.product_id],
    )
    const owed = n?.n ?? 0
    if (owed > 0) out.push(...rows.slice(owed))
  }
  return out
}

async function takeBack(tx: SqlDriver, r: Row): Promise<void> {
  const held = await tx.get<{ qty_on_hand: number }>(
    'SELECT qty_on_hand FROM product_stock WHERE product_id = ?', [r.product_id])
  // raw: the row is derived from the one it answers; the id makes it the same row on every till.
  await tx.execute(
    `INSERT OR IGNORE INTO stock_ledger
       (id, product_id, posting_date, qty_change, unit_cost, balance_qty, voucher_type, voucher_id,
        created_by, created_at, value_change, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      `${r.id}~dup`, r.product_id, r.posting_date, -r.qty_change, r.unit_cost,
      (held?.qty_on_hand ?? 0) - r.qty_change, VOIDED(r.voucher_type.slice(0, -'_reversal'.length)),
      r.voucher_id, r.created_by, new Date().toISOString(),
      r.value_change === null ? null : -r.value_change,
    ],
  )
}
