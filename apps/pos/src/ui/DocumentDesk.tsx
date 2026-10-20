import { useCallback, useEffect, useState } from 'react'
import {
  Permissions, listDocuments, loadDocument, type DocumentKind, type DocumentStatus,
  type DocumentListItem, type DocumentDetail,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import {
  Card, Empty, Alert, Rupees, DocStatusBadge, DateRangePicker, rangePreset, type Range,
} from './components'
import { Detail } from './documentDesk/Detail'
import { Draft } from './documentDesk/Draft'
import { PROGRESS, STATUS_LABELS } from './documentDesk/labels'
import type { DeskConfig } from './documentDesk/types'

export type { DeskConfig } from './documentDesk/types'

/**
 * Quotations, sales orders and purchase orders, on one screen shape.
 *
 * The three differ in who they are addressed to and what they turn into, and in
 * nothing else — same lines, same pricing, same totals, same numbering. So this
 * is one component the two pages configure, rather than two screens that would
 * start the same and drift apart at the first change to either.
 *
 * A document moves no stock and no money. Submitting it means only that it can
 * no longer be edited and that something can now be made from it, which is why
 * the buttons here say "Issue" and never "Post".
 */

export function DocumentDesk({ config }: { config: DeskConfig }) {
  const { db, registerId } = useCore()
  const user = useUser()
  const canWrite = Permissions.can(user.permissions, 'document', 'create')
  const canCancel = Permissions.can(user.permissions, 'document', 'cancel')
  /* Billing an order is a sale, so it is the counter's permission that decides
     it — not this screen's. A stockist who may raise a purchase order has no
     business ringing one up. */
  const canBill = Permissions.can(user.permissions, 'bill', 'create')
    && Permissions.visiblePages(user.permissions).includes('billing')

  const [kind, setKind] = useState<DocumentKind>(config.kinds[0]!)
  const [status, setStatus] = useState<DocumentStatus>('issued')
  const [range, setRange] = useState<Range>(rangePreset('month'))
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<DocumentListItem[]>([])
  const [open, setOpen] = useState<DocumentDetail | null>(null)
  const [drafting, setDrafting] = useState(false)
  /** A draft opened again in the form, to change it before it is issued. */
  const [editing, setEditing] = useState<DocumentDetail | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRows(await listDocuments(db, {
      kind, status, from: range.from, to: range.to, search: search.trim(),
    }))
  }, [db, kind, status, range.from, range.to, search])

  useEffect(() => { void refresh() }, [refresh])

  const label = config.labels[kind]!

  async function reopen(id: string) {
    setOpen(await loadDocument(db, id))
    await refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1000 }}>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      {config.kinds.length > 1 && (
        <div className="segment">
          {config.kinds.map((k) => (
            <button key={k} type="button" aria-pressed={k === kind} onClick={() => setKind(k)}>
              {config.labels[k]!.plural}
            </button>
          ))}
        </div>
      )}

      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>{label.note}</div>

      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <DateRangePicker value={range} onChange={setRange} />
          <div className="segment">
            {(['open', 'completed', 'draft', 'cancelled', 'all'] as DocumentStatus[]).map((s) => (
              <button key={s} type="button" aria-pressed={s === status} onClick={() => setStatus(s)}>
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
          <input
            className="input" style={{ flex: 1, minWidth: 160 }} id="doc-search"
            placeholder="Number or name" value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {canWrite && (
            <button className="btn primary" onClick={() => { setDrafting(true); setError(null); setNotice(null) }}>
              New {label.name.toLowerCase()}
            </button>
          )}
        </div>
      </Card>

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Date</th>
              <th>{config.party === 'supplier' ? 'Supplier' : 'Customer'}</th>
              <th>State</th>
              <th className="r">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => void reopen(r.id)} style={{ cursor: 'pointer' }}>
                <td>{r.docNo}</td>
                <td>{r.postingDate}</td>
                <td>{r.partyName ?? <span style={{ color: 'var(--ink-3)' }}>Not recorded</span>}</td>
                <td>
                  <DocStatusBadge status={r.docstatus} />
                  {r.docstatus === 1 && <span className="src"> {PROGRESS[r.progress]}</span>}
                </td>
                <td className="r"><Rupees value={r.grandTotal} /></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5}><Empty>Nothing here for those dates</Empty></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(drafting || editing) && (
        <Draft
          key={editing?.id ?? 'new'}
          config={config}
          kind={editing?.kind ?? kind}
          editing={editing}
          onClose={() => { setDrafting(false); setEditing(null) }}
          onDone={(message) => { setDrafting(false); setEditing(null); setNotice(message); void refresh() }}
          onError={setError}
          registerId={registerId}
          userId={user.id}
        />
      )}

      {open && (
        <Detail
          doc={open}
          config={config}
          canCancel={canCancel}
          canWrite={canWrite}
          canBill={canBill}
          onClose={() => setOpen(null)}
          onChanged={(message) => { setNotice(message); void reopen(open.id) }}
          onError={setError}
          onEdit={() => { setEditing(open); setOpen(null); setError(null); setNotice(null) }}
          userId={user.id}
        />
      )}
    </div>
  )
}
