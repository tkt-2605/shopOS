import { and, eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import {
  assertBalanced, credit, debit, isAccount, normalise, type AccountKey, type GlLine, type GlParty,
} from '../../domain/ledger.js'

/*
 * Writing a voucher's lines, and taking them back.
 *
 * Both are idempotent: a voucher already posted is left as it is, and so is
 * one already reversed. That is what lets `postMissingGl` run on every till
 * after every merge without anything being counted twice -- and the ids are
 * derived from the voucher, so a till that posts what another till also
 * posted writes the same rows rather than a second set.
 */

export interface Voucher {
  type: string
  id: string
  postingDate: string
}

async function hasLines(tx: SqlDriver, voucher: Voucher, reversal: boolean): Promise<boolean> {
  const [row] = await q(tx)
    .select({ id: schema.glEntries.id })
    .from(schema.glEntries)
    .where(and(
      eq(schema.glEntries.voucherType, voucher.type),
      eq(schema.glEntries.voucherId, voucher.id),
      eq(schema.glEntries.isReversal, reversal ? 1 : 0),
    ))
    .limit(1)
  return row !== undefined
}

async function write(tx: SqlDriver, voucher: Voucher, lines: GlLine[], reversal: boolean): Promise<void> {
  const now = new Date().toISOString()
  for (const [i, l] of lines.entries()) {
    await q(tx).insert(schema.glEntries).values({
      id: `${voucher.type}:${voucher.id}:${reversal ? 'r' : ''}${i}`,
      postingDate: voucher.postingDate,
      account: l.account,
      partyType: l.party?.type ?? null,
      partyId: l.party?.id ?? null,
      debit: l.debit,
      credit: l.credit,
      voucherType: voucher.type,
      voucherId: voucher.id,
      isReversal: reversal ? 1 : 0,
      createdAt: now,
    }).onConflictDoNothing()
  }
}

/**
 * Posts a voucher's lines, once. Throws if they do not balance -- inside the
 * document's own transaction, so a document whose books would not add up is
 * not issued at all.
 */
export async function postGl(tx: SqlDriver, voucher: Voucher, lines: readonly GlLine[]): Promise<void> {
  const rows = normalise(lines)
  assertBalanced(`${voucher.type} ${voucher.id}`, rows)
  if (rows.length === 0 || await hasLines(tx, voucher, false)) return
  await write(tx, voucher, rows, false)
}

/**
 * Posts the mirror of a voucher's lines, on the voucher's own date.
 *
 * Stock is the exception. Goods put back by a cancellation are valued by the
 * stock ledger as they go back -- at the average on the shelf, not always at
 * what they left at -- so the stock line is what the reversing movements
 * actually came to (`stockValue`), and any difference from the mirrored cost is
 * a stock adjustment. That keeps the stock account equal to the stock ledger,
 * to the paisa, which is the check `ledgerChecks` makes.
 */
export async function reverseGl(
  tx: SqlDriver,
  voucher: Voucher,
  stockValue: number | null,
): Promise<void> {
  if (await hasLines(tx, voucher, true)) return
  const original = await q(tx)
    .select({
      account: schema.glEntries.account,
      partyType: schema.glEntries.partyType,
      partyId: schema.glEntries.partyId,
      debit: schema.glEntries.debit,
      credit: schema.glEntries.credit,
    })
    .from(schema.glEntries)
    .where(and(
      eq(schema.glEntries.voucherType, voucher.type),
      eq(schema.glEntries.voucherId, voucher.id),
      eq(schema.glEntries.isReversal, 0),
    ))
  if (original.length === 0) return

  const mirrored: GlLine[] = original
    .filter((o) => stockValue === null || o.account !== 'stock')
    .map((o): GlLine => {
      if (!isAccount(o.account)) throw new Error(`gl_entries holds an account this build does not know: ${o.account}`)
      const party: GlParty | null = o.partyType === 'customer' || o.partyType === 'supplier'
        ? { type: o.partyType, id: o.partyId }
        : null
      return { account: o.account as AccountKey, debit: o.credit, credit: o.debit, party }
    })

  const lines = stockValue === null ? mirrored : [...mirrored, debit('stock', stockValue)]
  const out = normalise(lines)
  const gap = out.reduce((s, l) => s + l.debit - l.credit, 0)
  // What the goods came back at, against what they were costed at going out.
  if (gap !== 0) out.push(...normalise([credit('stock_adjustment', gap)]))

  assertBalanced(`${voucher.type} ${voucher.id} reversal`, out)
  await write(tx, voucher, out, true)
}
