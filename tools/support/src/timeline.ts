import type { SqlDriver } from '@shopos/core'

/*
 * Everything that touched one document, in the order it happened: the
 * audit's own record of who did what, the change feed's record of which till
 * it came from, the clashes and the set-asides sync recorded about it, what
 * it posted to the books and the stock, and the documents that point at it.
 *
 * The question this answers is the one every support case comes down to --
 * "what happened to INV/2627/00042" -- and until now it was a dozen queries
 * typed by hand over a remote session.
 */

const DOCUMENT_TABLES = ['bills', 'sales_returns', 'payment_entries', 'documents', 'stock_entries', 'stock_counts'] as const

export interface Found {
  table: string
  id: string
  docNo: string
}

export interface Event {
  at: string
  what: string
}

/** The document a number or an id names, in whichever table holds it. */
export async function findDocument(db: SqlDriver, ref: string): Promise<Found | null> {
  for (const table of DOCUMENT_TABLES) {
    const row = await db.get<{ id: string; doc_no: string }>(
      `SELECT id, doc_no FROM ${table} WHERE doc_no = ? OR id = ?`, [ref, ref], // raw: the table is one of six fixed names
    ).catch(() => undefined)
    if (row) return { table, id: row.id, docNo: row.doc_no }
  }
  return null
}

export async function timeline(db: SqlDriver, doc: Found): Promise<Event[]> {
  const events: Event[] = []
  const add = (at: string | null | undefined, what: string) => { if (at) events.push({ at, what }) }
  const q = <T>(sql: string, params: (string | number | null)[]) => db.query<T>(sql, params).catch(() => [] as T[])

  const self = (await q<Record<string, unknown>>(`SELECT * FROM ${doc.table} WHERE id = ?`, [doc.id]))[0] ?? {}
  add(self['created_at'] as string, `${doc.docNo} created (${doc.table}, status ${self['docstatus'] ?? '?'} now)`)
  if (self['updated_at'] !== self['created_at']) add(self['updated_at'] as string, `${doc.docNo} last changed, rev ${self['rev'] ?? '?'}`)
  if (self['cancelled_at']) add(self['cancelled_at'] as string, `${doc.docNo} cancelled: ${self['cancel_reason'] ?? 'no reason given'}`)

  for (const a of await q<{ at: string; action: string; username: string | null; docstatus_from: number | null; docstatus_to: number | null; diff: string | null; device_id: string | null }>(
    `SELECT a.at, a.action, u.username, a.docstatus_from, a.docstatus_to, a.diff, a.device_id
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.entity_id = ? ORDER BY a.at`, [doc.id])) {
    const status = a.docstatus_to !== null ? ` (${a.docstatus_from ?? '-'} -> ${a.docstatus_to})` : ''
    add(a.at, `audit: ${a.action}${status} by ${a.username ?? 'someone'}${a.device_id ? ` on ${a.device_id.slice(0, 8)}` : ''}${a.diff ? ` ${a.diff.slice(0, 160)}` : ''}`)
  }

  for (const f of await q<{ at: string; seq: number; op: string; origin_device: string | null }>(
    'SELECT at, seq, op, origin_device FROM change_feed WHERE row_id = ? ORDER BY seq', [doc.id])) {
    add(f.at, `feed: ${f.op} #${f.seq} ${f.origin_device ? `from till ${f.origin_device.slice(0, 8)}` : 'made on this till'}`)
  }

  for (const c of await q<{ at: string; peer_device: string | null; winner: string; explain: string | null }>(
    'SELECT at, peer_device, winner, explain FROM sync_conflicts WHERE row_id = ? ORDER BY at', [doc.id])) {
    add(c.at, `clash with ${c.peer_device?.slice(0, 8) ?? 'a till'}: ${c.winner} kept${c.explain ? ` -- ${c.explain}` : ''}`)
  }

  for (const s of await q<{ at: string; peer_device: string | null; reason: string; acknowledged: number }>(
    'SELECT at, peer_device, reason, acknowledged FROM sync_quarantine WHERE row_id = ? ORDER BY at', [doc.id])) {
    add(s.at, `set aside from ${s.peer_device?.slice(0, 8) ?? 'a till'}: ${s.reason}${s.acknowledged ? ' (seen)' : ''}`)
  }

  for (const g of await q<{ at: string; n: number; debit: number; reversal: number }>(
    `SELECT MIN(created_at) AS at, COUNT(*) AS n, SUM(debit) AS debit, MAX(is_reversal) AS reversal
       FROM gl_entries WHERE voucher_id = ? GROUP BY is_reversal`, [doc.id])) {
    add(g.at, `books: ${g.n} ${g.reversal ? 'reversing ' : ''}entries, ${g.debit} paise each side`)
  }

  for (const s of await q<{ at: string; n: number; qty: number }>(
    'SELECT MIN(created_at) AS at, COUNT(*) AS n, SUM(qty_change) AS qty FROM stock_ledger WHERE voucher_id = ? GROUP BY qty_change < 0', [doc.id])) {
    add(s.at, `stock: ${s.n} movement(s), ${s.qty} units (x10^4) net`)
  }

  if (doc.table === 'bills') {
    for (const r of await q<{ created_at: string; doc_no: string; docstatus: number }>(
      'SELECT created_at, doc_no, docstatus FROM sales_returns WHERE bill_id = ?', [doc.id])) {
      add(r.created_at, `return ${r.doc_no} against it (status ${r.docstatus})`)
    }
    for (const p of await q<{ created_at: string; doc_no: string; docstatus: number; amount: number }>(
      `SELECT p.created_at, p.doc_no, p.docstatus, a.amount FROM payment_allocations a
         JOIN payment_entries p ON p.id = a.payment_id WHERE a.bill_id = ?`, [doc.id])) {
      add(p.created_at, `payment ${p.doc_no} put ${p.amount} paise against it (status ${p.docstatus})`)
    }
  }
  if (doc.table === 'payment_entries') {
    for (const a of await q<{ doc_no: string; amount: number; created_at: string }>(
      `SELECT b.doc_no, a.amount, b.created_at FROM payment_allocations a JOIN bills b ON b.id = a.bill_id WHERE a.payment_id = ?`, [doc.id])) {
      add(self['created_at'] as string, `paid ${a.amount} paise against ${a.doc_no}`)
    }
  }

  return events.sort((a, b) => a.at.localeCompare(b.at))
}

export function renderTimeline(doc: Found, events: readonly Event[]): string {
  return [`${doc.docNo} (${doc.table} ${doc.id})`, ...events.map((e) => `  ${e.at}  ${e.what}`)].join('\n')
}
