import {
  findDiscrepancies, recomputeStock, reconcileReturnedQty, reconcileFulfilledQty, reconcileLoyalty, type SqlDriver,
} from '@shopos/core'
import { reconcileDoubleReversals } from '../../../packages/core/src/services/stockReversals.js'
import { health } from '../../virtual-till/src/books.js'

/*
 * Every check there is, run over one shop's database, read out as a page.
 *
 * The same code the till runs: Needs Attention's checks, the reconcilers that
 * keep each cached figure honest (asked only what they *would* change), the
 * books against themselves, the numbering, and what sync has set aside. So
 * what support reads here is what the shop would see, plus what the shop is
 * never shown because a cashier cannot act on it.
 */

export interface Section {
  title: string
  ok: boolean
  lines: string[]
}

const SHOW = 8

export async function checkShop(db: SqlDriver): Promise<Section[]> {
  const sections: Section[] = []
  const add = (title: string, ok: boolean, lines: string[]) => sections.push({ title, ok, lines })
  const q = <T>(sql: string, params: (string | number | null)[] = []) => db.query<T>(sql, params)

  /* ── the file ─────────────────────────────────────────────────────── */
  const integrity = await q<{ quick_check: string }>('PRAGMA quick_check')
  const fk = await q<{ table: string; rowid: number; parent: string }>('PRAGMA foreign_key_check')
  const intact = integrity.length === 1 && integrity[0]!.quick_check === 'ok'
  add('Database', intact && fk.length === 0, [
    intact ? 'Integrity check: ok.' : `Integrity check: ${integrity.slice(0, SHOW).map((r) => r.quick_check).join('; ')}`,
    fk.length === 0 ? 'Every record points at something that exists.'
      : `${fk.length} record(s) point at something missing, e.g. ${fk.slice(0, SHOW).map((r) => `${r.table} row ${r.rowid} -> ${r.parent}`).join(', ')}`,
  ])

  /* ── the books ────────────────────────────────────────────────────── */
  const books = await health(db)
  const unbalanced = await q<{ voucher_type: string; voucher_id: string; off: number }>(
    `SELECT voucher_type, voucher_id, SUM(debit) - SUM(credit) AS off FROM gl_entries
      GROUP BY voucher_type, voucher_id HAVING off <> 0 LIMIT ${SHOW}`,
  )
  const noBooks = await q<{ doc_no: string }>(
    `SELECT doc_no FROM bills b WHERE b.docstatus = 1
        AND NOT EXISTS (SELECT 1 FROM gl_entries g WHERE g.voucher_id = b.id) LIMIT ${SHOW}`,
  )
  add('Books', books.unbalancedVouchers === 0 && noBooks.length === 0, [
    books.unbalancedVouchers === 0 ? 'Every voucher balances.'
      : `${books.unbalancedVouchers} voucher(s) do not balance: ${unbalanced.map((u) => `${u.voucher_type} ${u.voucher_id} off by ${u.off} paise`).join(', ')}`,
    noBooks.length === 0 ? 'Every submitted bill is in the books.' : `Submitted bills with no entries: ${noBooks.map((b) => b.doc_no).join(', ')}`,
  ])

  /* ── cached figures, asked what they would change ─────────────────── */
  const stock = await recomputeStock(db)
  const returned = await reconcileReturnedQty(db)
  const fulfilled = await reconcileFulfilledQty(db)
  const loyalty = await reconcileLoyalty(db)
  const reversals = await reconcileDoubleReversals(db)
  const figures: [string, unknown[]][] = [
    ['stock on hand', stock], ['returned quantities', returned], ['order quantities billed', fulfilled],
    ['loyalty points', loyalty], ['stock reversed twice', reversals],
  ]
  add('Cached figures', figures.every(([, d]) => d.length === 0), figures.map(([name, drift]) =>
    drift.length === 0 ? `${name}: agrees with its records.`
      : `${name}: ${drift.length} differ, e.g. ${drift.slice(0, 3).map((d) => JSON.stringify(d)).join(' ')}`))

  /* ── what Needs Attention shows the shop ──────────────────────────── */
  const found = await findDiscrepancies(db)
  add('Needs Attention', found.length === 0, found.length === 0 ? ['Nothing.']
    : found.slice(0, 30).map((d) => `[${d.area}] ${d.title}${d.refs.length ? ` (${d.refs.slice(0, 6).join(', ')})` : ''}`))

  /* ── numbering ────────────────────────────────────────────────────── */
  add('Bill numbers', books.missingNumbers.length === 0, [
    `${books.bills} bill(s) rung up, ${books.drafts} draft(s) on this till.`,
    books.missingNumbers.length === 0 ? 'No gaps in any series.'
      : `Missing from the series: ${books.missingNumbers.slice(0, 20).join(', ')}${books.missingNumbers.length > 20 ? ` and ${books.missingNumbers.length - 20} more` : ''}`,
  ])

  /* ── sync ─────────────────────────────────────────────────────────── */
  const peers = await q<{ device_id: string; label: string | null; last_agreed_at: string | null; last_error: string | null; clock_skew_ms: number | null; reach: string | null }>(
    'SELECT device_id, label, last_agreed_at, last_error, clock_skew_ms, reach FROM sync_peers ORDER BY label',
  )
  const setAside = await q<{ table_name: string; reason: string; n: number; waiting: number }>(
    `SELECT table_name, reason, COUNT(*) AS n, SUM(CASE WHEN acknowledged = 0 THEN 1 ELSE 0 END) AS waiting
       FROM sync_quarantine GROUP BY table_name, reason ORDER BY n DESC LIMIT ${SHOW}`,
  )
  const conflicts = await q<{ table_name: string; n: number }>(
    'SELECT table_name, COUNT(*) AS n FROM sync_conflicts GROUP BY table_name ORDER BY n DESC',
  )
  const feed = await q<{ origin_device: string | null; n: number; last: number }>(
    'SELECT origin_device, COUNT(*) AS n, MAX(seq) AS last FROM change_feed GROUP BY origin_device ORDER BY n DESC',
  )
  const waiting = setAside.reduce((n, s) => n + s.waiting, 0)
  add('Sync', waiting === 0 && peers.every((p) => !p.last_error), [
    peers.length === 0 ? 'No other tills paired.' : `${peers.length} till(s) paired:`,
    ...peers.map((p) => `  ${p.label ?? p.device_id.slice(0, 8)}${p.reach ? ` (${p.reach})` : ''}: agreed ${p.last_agreed_at ?? 'never'}`
      + `${p.clock_skew_ms ? `, clock ${Math.round(p.clock_skew_ms / 1000)} s off` : ''}${p.last_error ? `, last error: ${p.last_error}` : ''}`),
    setAside.length === 0 ? 'Nothing set aside.'
      : `Set aside (${waiting} waiting): ${setAside.map((s) => `${s.n} ${s.table_name}: ${s.reason}`).join('; ')}`,
    conflicts.length === 0 ? 'No changes were dropped in a clash.'
      : `Changes dropped in a clash: ${conflicts.map((c) => `${c.n} ${c.table_name}`).join(', ')}`,
    `Change feed: ${feed.map((f) => `${f.n} from ${f.origin_device?.slice(0, 8) ?? 'this till'}`).join(', ') || 'empty'}.`,
  ])

  /* ── counters ─────────────────────────────────────────────────────── */
  const known = new Set(peers.map((p) => p.device_id))
  const registers = await q<{ name: string; prefix: string; claimed_by: string | null; claim_seq: number | null; is_active: number }>(
    'SELECT name, prefix, claimed_by, claim_seq, is_active FROM registers ORDER BY name',
  ).catch(() => [])
  const strangers = registers.filter((r) => r.claimed_by !== null && !known.has(r.claimed_by))
  add('Counters', true, registers.map((r) => `${r.name} (${r.prefix})${r.is_active ? '' : ' retired'}: `
    + (r.claimed_by === null ? 'free' : `held by ${r.claimed_by.slice(0, 8)}${known.has(r.claimed_by) ? '' : ' (this till, or one not paired)'}`)
    + (r.claim_seq ? `, claim ${r.claim_seq}` : ''))
    .concat(strangers.length > 1 ? [`${strangers.length} counters are held by tills this one is not paired with: one is itself; any others may be gone.`] : []))

  return sections
}

export function render(sections: readonly Section[]): string {
  return sections.map((s) => [`== ${s.title}  ${s.ok ? 'ok' : 'LOOK AT THIS'}`, ...s.lines.map((l) => `   ${l}`)].join('\n')).join('\n\n')
}
