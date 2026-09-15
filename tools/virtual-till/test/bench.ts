import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetNonces, newId, type SqlDriver } from '@shopos/core'
import { removeTillContext } from '../src/context.js'
import { startTill, type Till, type TillOptions } from '../src/till.js'

/**
 * The bits every scenario needs and none of them are about.
 *
 * Kept deliberately thin. A helper that sets up "two paired tills" in one call
 * would hide which side initiated, and which side initiated is the whole
 * subject of this package.
 */

const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
const TILL_B = '2222bbbb-2222-4222-8222-222222222222'
const TILL_C = '3333cccc-3333-4333-8333-333333333333'

export const DEVICE_IDS = { a: TILL_A, b: TILL_B, c: TILL_C }

let roots: string[] = []
let running: Till[] = []

export function benchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shopos-bench-'))
  roots.push(dir)
  return dir
}

/**
 * Starts a till and remembers it, so a scenario that throws halfway still
 * releases its port and its file handle. A leaked listener makes the *next*
 * file fail, which is the worst way to debug a bench.
 */
export async function till(opts: TillOptions): Promise<Till> {
  const started = await startTill(opts)
  running.push(started)
  return started
}

/** The till that already has the shop. */
export function host(over: Partial<TillOptions> = {}): Promise<Till> {
  return till({
    dataDir: benchDir(), deviceId: TILL_A, label: 'Front counter',
    registerPrefix: 'FR', seed: 'shop', ...over,
  })
}

/** A till that has been installed and nothing else. */
export function joiner(over: Partial<TillOptions> = {}): Promise<Till> {
  return till({
    dataDir: benchDir(), deviceId: TILL_B, label: 'Back counter',
    registerPrefix: 'BC', seed: 'empty', ...over,
  })
}

export async function stopAll(): Promise<void> {
  for (const t of running) {
    try { await t.stop() } catch { /* a scenario may have stopped it already */ }
  }
  running = []
  removeTillContext()
  forgetNonces()
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  roots = []
}

/**
 * A bill, written the short way.
 *
 * Deliberately raw SQL rather than `createBill`/`submitBill`: these scenarios
 * are about replication, and a bill that goes through the full service is a
 * bill whose failure could be pricing, stock policy or numbering. What
 * replication cares about is that a row exists on one till and arrives at the
 * other. `same-register.test.ts` is the exception and says so.
 */
export async function writeBill(
  db: SqlDriver, registerId: string, opts: { docNo: string; total?: number },
): Promise<string> {
  const id = newId()
  const now = new Date().toISOString()
  const total = opts.total ?? 10000
  // Whoever the till has. `created_by` is NOT NULL and a foreign key, so a
  // bill with no user is not a bill this schema will hold.
  const user = await db.get<{ id: string }>(`SELECT id FROM users LIMIT 1`)
  await db.execute(
    `INSERT INTO bills
       (id, doc_no, register_id, posting_date, docstatus,
        subtotal, taxable_total, grand_total, paid_total,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.docNo, registerId, now.slice(0, 10), total, total, total, total,
     user!.id, now, now],
  )
  return id
}

export async function billIds(db: SqlDriver): Promise<string[]> {
  const rows = await db.query<{ id: string }>(`SELECT id FROM bills ORDER BY id`)
  return rows.map((r) => r.id)
}

export async function countOf(db: SqlDriver, table: string): Promise<number> {
  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
  return row?.n ?? 0
}
