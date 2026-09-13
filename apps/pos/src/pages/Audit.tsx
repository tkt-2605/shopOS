import { useCallback, useEffect, useState } from 'react'
import {
  listAuditEntries, auditEntities, auditActors, Money, businessDate, addDays, Reports as R,
  type AuditEntry, type FieldChange,
} from '@shopos/core'
import { useDb } from '../core/CoreProvider'
import { Card, Field, Empty, Alert } from '../ui/components'
import { saveFile } from '../core/exportFile'

/**
 * What happened, in order, and who did it.
 *
 * Every service writes its audit row inside the same transaction as the change,
 * so this is not a best-effort log: a row here means the change committed, and a
 * change that committed has a row. Nothing had ever read it.
 *
 * The screen answers three questions a shop actually asks — who changed this
 * price, when was that bill cancelled and by whom, and "I did not do that".
 */

const PAGE = 100

/** Values worth showing as money rather than as a count of paise. */
const MONEY_FIELDS = new Set([
  'rate', 'base_rate', 'mrp', 'grand_total', 'amount', 'discount', 'credit_limit',
  'line_total', 'unit_cost', 'opening_float', 'closing_count',
])

const ACTION_LABEL: Record<string, string> = {
  create: 'created', update: 'changed', delete: 'removed',
  submit: 'submitted', cancel: 'cancelled', amend: 'amended',
  login: 'signed in', login_failed: 'failed to sign in',
}

const ENTITY_LABEL: Record<string, string> = {
  bills: 'Bill', sales_returns: 'Return', payment_entries: 'Payment',
  stock_entries: 'Stock entry', stock_counts: 'Stock count', products: 'Item',
  customers: 'Customer', suppliers: 'Supplier', users: 'Staff', roles: 'Role',
  price_lists: 'Price list', item_prices: 'Item price',
  customer_item_prices: 'Customer rate', attachments: 'Attachment',
  cash_sessions: 'Cash session', settings: 'Setting',
}

export default function Audit() {
  const db = useDb()
  const [rows, setRows] = useState<AuditEntry[]>([])
  const [entities, setEntities] = useState<string[]>([])
  const [actors, setActors] = useState<{ id: string; name: string }[]>([])
  const [term, setTerm] = useState('')
  const [entity, setEntity] = useState('')
  const [actorId, setActorId] = useState('')
  const [from, setFrom] = useState(() => addDays(businessDate(), -30))
  const [to, setTo] = useState(() => businessDate())
  const [page, setPage] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setRows(await listAuditEntries(db, {
      term, ...(entity ? { entity } : {}), ...(actorId ? { actorId } : {}),
      from, to, limit: PAGE, offset: page * PAGE,
    }))
    setLoading(false)
  }, [db, term, entity, actorId, from, to, page])

  useEffect(() => {
    const id = setTimeout(() => void refresh(), term === '' ? 0 : 160)
    return () => clearTimeout(id)
  }, [refresh, term])

  useEffect(() => {
    void auditEntities(db).then(setEntities)
    void auditActors(db).then(setActors)
  }, [db])

  // Any change of filter starts again from the top; staying on page four of a
  // different question is never what was meant.
  useEffect(() => { setPage(0) }, [term, entity, actorId, from, to])

  async function exportCsv() {
    const all = await listAuditEntries(db, {
      term, ...(entity ? { entity } : {}), ...(actorId ? { actorId } : {}), from, to, limit: 5000,
    })
    const csv = R.toCsv(
      ['When', 'Who', 'What', 'Which', 'Action', 'Changes'],
      all.map((r) => [
        r.at, r.actorName ?? '—', ENTITY_LABEL[r.entity] ?? r.entity, r.subject ?? r.entityId,
        ACTION_LABEL[r.action] ?? r.action,
        r.changes.map((c) => `${c.field}: ${describe(c, false)} → ${describe(c, true)}`).join('; '),
      ]),
    )
    const saved = await saveFile(`audit-${from}-to-${to}.csv`, csv)
    setNotice(saved.ok ? `Saved to ${saved.path}` : saved.message)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1040 }}>
      {notice && <Alert kind="ok">{notice}</Alert>}

      <Card
        title="What happened"
        actions={<button className="btn sm" onClick={() => void exportCsv()}>Export</button>}
      >
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
          Every change the shop has made, newest first. Each line is written at the same moment as
          the change itself, so nothing here is a guess and nothing is missing.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
          <Field label="Search">
            <input className="input" value={term} onChange={(e) => setTerm(e.target.value)}
              placeholder="Name, number, field" />
          </Field>
          <Field label="What">
            <select className="input" value={entity} onChange={(e) => setEntity(e.target.value)}>
              <option value="">Everything</option>
              {entities.map((e) => <option key={e} value={e}>{ENTITY_LABEL[e] ?? e}</option>)}
            </select>
          </Field>
          <Field label="Who">
            <select className="input" value={actorId} onChange={(e) => setActorId(e.target.value)}>
              <option value="">Anyone</option>
              {actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="From">
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </Card>

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 150 }}>When</th>
              <th style={{ width: 130 }}>Who</th>
              <th>What</th>
              <th>Changed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>{when(row.at)}</td>
                <td>{row.actorName ?? <span style={{ color: 'var(--ink-3)' }}>the system</span>}</td>
                <td>
                  <span className={badgeFor(row.action)}>{ACTION_LABEL[row.action] ?? row.action}</span>{' '}
                  {ENTITY_LABEL[row.entity] ?? row.entity}
                  {row.subject && <> — {row.subject}</>}
                  {row.docstatusTo !== null && row.docstatusFrom !== row.docstatusTo && (
                    <div className="src">{status(row.docstatusFrom)} → {status(row.docstatusTo)}</div>
                  )}
                </td>
                <td>
                  {row.changes.length === 0 ? (
                    <span style={{ color: 'var(--ink-3)' }}>—</span>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {row.changes.map((c) => (
                        <div key={c.field} style={{ fontSize: 12 }}>
                          <span style={{ color: 'var(--ink-3)' }}>{label(c.field)}</span>{' '}
                          <span style={{ textDecoration: 'line-through', color: 'var(--ink-3)' }}>
                            {describe(c, false)}
                          </span>{' '}
                          → <span>{describe(c, true)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4}><Empty>{loading ? 'Looking…' : 'Nothing in that range'}</Empty></td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          Newer
        </button>
        <button className="btn" disabled={rows.length < PAGE} onClick={() => setPage((p) => p + 1)}>
          Older
        </button>
        {page > 0 && <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>page {page + 1}</span>}
      </div>
    </div>
  )
}

function when(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString()
}

function status(value: number | null): string {
  return value === 0 ? 'draft' : value === 1 ? 'submitted' : value === 2 ? 'cancelled' : '—'
}

function badgeFor(action: string): string {
  if (action === 'cancel' || action === 'delete' || action === 'login_failed') return 'badge bad'
  if (action === 'submit' || action === 'create') return 'badge ok'
  return 'badge'
}

function label(field: string): string {
  return field.replace(/_/g, ' ')
}

/** Paise read as paise unless the field is money, and null reads as "nothing". */
function describe(change: FieldChange, after: boolean): string {
  const value = after ? change.to : change.from
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number' && MONEY_FIELDS.has(change.field)) return Money.formatWithSymbol(value as never)
  if (typeof value === 'number' && (change.field.endsWith('_blocked') || change.field.startsWith('is_'))) {
    return value === 1 ? 'yes' : 'no'
  }
  return String(value)
}
