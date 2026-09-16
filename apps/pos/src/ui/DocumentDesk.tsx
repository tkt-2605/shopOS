import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Money, Quantity, Permissions,
  searchProducts, searchCustomers, listSuppliers,
  createDocument, submitDocument, cancelDocument, listDocuments, loadDocument,
  quotationToSalesOrder, receivePurchaseOrder, documentToCart,
  type ProductListItem, type CustomerListItem, type Supplier,
  type DocumentKind, type DocumentStatus, type DocumentListItem, type DocumentDetail,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { printDocumentSheet } from '../core/printHtml'
import { requestRepeat } from '../core/repeat'
import {
  Card, Field, Modal, Empty, Alert, Rupees, DocStatusBadge,
  DateRangePicker, rangePreset, type Range,
} from './components'
import { usePickList } from './PickList'

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

export interface DeskConfig {
  /** The kinds this page offers, in the order the segment shows them. */
  kinds: DocumentKind[]
  /** Which side of the shop the document is addressed to. */
  party: 'customer' | 'supplier'
  /** What each kind is called, and the sentence under the tab explaining it. */
  labels: Record<string, { name: string; plural: string; note: string }>
}

interface Line {
  key: string
  product: ProductListItem
  qty: string
  /** A rate somebody typed. Blank means "whatever the price list says today". */
  rate: string
}

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
            <button key={k} className={k === kind ? 'on' : ''} onClick={() => setKind(k)}>
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
              <button key={s} aria-selected={s === status} onClick={() => setStatus(s)}>
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

      {drafting && (
        <Draft
          config={config}
          kind={kind}
          onClose={() => setDrafting(false)}
          onDone={(message) => { setDrafting(false); setNotice(message); void refresh() }}
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
          userId={user.id}
        />
      )}
    </div>
  )
}

const STATUS_LABELS: Record<DocumentStatus, string> = {
  /* "Open" rather than "Issued", because issued is what they all are and it
     therefore told a shopkeeper nothing. The list they actually want is the one
     with something still to do on it — a quotation won and billed last month
     sat in "Issued" for ever, beside the ones still waiting for an answer. */
  open: 'Open', completed: 'Completed', draft: 'Drafts',
  cancelled: 'Cancelled', all: 'All', issued: 'Issued',
}

/** Against a submitted document, how much of it has been acted on. */
const PROGRESS: Record<DocumentListItem['progress'], string> = {
  open: 'nothing yet', part: 'part done', done: 'done',
}

/* ---------------------------------------------------------- the drafting --- */

function Draft({ config, kind, onClose, onDone, onError, registerId, userId }: {
  config: DeskConfig
  kind: DocumentKind
  onClose: () => void
  onDone: (message: string) => void
  onError: (message: string | null) => void
  registerId: string | null
  userId: string
}) {
  const { db } = useCore()
  const [partyId, setPartyId] = useState('')
  const [customers, setCustomers] = useState<CustomerListItem[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [validUntil, setValidUntil] = useState('')
  const [notes, setNotes] = useState('')
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<ProductListItem[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)

  const label = config.labels[kind]!

  useEffect(() => {
    const id = setTimeout(() => { void searchProducts(db, { term, limit: 25 }).then(setResults) }, 140)
    return () => clearTimeout(id)
  }, [db, term])

  useEffect(() => {
    if (config.party === 'supplier') void listSuppliers(db).then(setSuppliers)
    else void searchCustomers(db, '', 200).then(setCustomers)
  }, [db, config.party])

  function add(product: ProductListItem) {
    setLines((prev) => prev.some((l) => l.product.id === product.id)
      ? prev
      : [...prev, { key: `${product.id}-${Date.now()}`, product, qty: '1', rate: '' }])
    setTerm('')
  }

  const pick = usePickList({
    count: results.length,
    resetKey: term,
    onPick: (i) => { const hit = results[i]; if (hit) add(hit) },
  })

  /* A rough figure, before tax and before the price list has been consulted.
     The real total is computed by the service through the same resolver the
     counter uses, and replaces this the moment the document is saved. */
  const rough = useMemo(() => lines.reduce((sum, l) => {
    const qty = Number(l.qty) || 0
    const rate = Money.parseMoney(l.rate) ?? l.product.baseRate
    return sum + Math.round(qty * rate)
  }, 0), [lines])

  async function save(issue: boolean) {
    if (!registerId) { onError('This machine is not set to a counter yet. Settings → Set up → Counters.'); return }
    setBusy(true)
    onError(null)

    const made = await createDocument(db, {
      kind,
      registerId,
      ...(config.party === 'supplier'
        ? { supplierId: partyId || null }
        : { customerId: partyId || null }),
      lines: lines.map((l) => {
        const typed = Money.parseMoney(l.rate)
        return {
          productId: l.product.id,
          qty: Quantity.fromUnits(Number(l.qty) || 0),
          ...(typed === null ? {} : { rateOverride: typed as never }),
        }
      }),
      ...(validUntil ? { validUntil } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      actorId: userId,
    })

    if (!made.ok) {
      setBusy(false)
      onError(
        made.code === 'NO_LINES' ? 'Add at least one item.'
        : made.code === 'INVALID_QTY' ? 'Every line needs a quantity above zero.'
        : made.code === 'PARTY_REQUIRED' ? `A ${config.party === 'supplier' ? 'purchase order needs a supplier' : 'document needs a customer'}.`
        : 'One of those items is no longer in the catalogue.',
      )
      return
    }

    if (!issue) {
      onDone(`Saved as a draft, ${made.docNo}. It is under Drafts until you issue it.`)
      return
    }

    const issued = await submitDocument(db, { documentId: made.documentId, actorId: userId })
    setBusy(false)
    if (!issued.ok) { onError('That document could not be issued.'); return }
    onDone(`${label.name} ${made.docNo} issued.`)
  }

  return (
    <Modal
      title={`New ${label.name.toLowerCase()}`}
      wide
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || lines.length === 0} onClick={() => void save(false)}>
          Save as draft
        </button>
        <button className="btn primary" disabled={busy || lines.length === 0} onClick={() => void save(true)}>
          Issue
        </button>
      </>}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
        <Field label={config.party === 'supplier' ? 'Supplier' : 'Customer'}>
          <select className="select" id="doc-party" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">Not recorded</option>
            {config.party === 'supplier'
              ? suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)
              : customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        {kind === 'quotation' && (
          <Field label="Valid until" hint="After this date the quoted price is no longer a promise.">
            <input className="input" id="doc-valid" type="date" value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        )}
        <Field label="Note" hint="Printed on the document.">
          <input className="input" id="doc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>

      <input
        className="input" style={{ marginTop: 12 }} id="doc-item-search"
        placeholder="Scan or search an item to add" value={term}
        onChange={(e) => setTerm(e.target.value)} onKeyDown={pick.searchKeyDown}
      />

      {term !== '' && (
        <div className="card" style={{ maxHeight: 200, overflow: 'auto', marginTop: 8 }}>
          <table>
            <tbody {...pick.listProps}>
              {results.map((p, i) => (
                <tr key={p.id} {...pick.rowProps(i)}>
                  <td>{p.name}{p.brand && <span style={{ color: 'var(--ink-3)' }}> · {p.brand}</span>}</td>
                  <td className="r num">{Quantity.formatQty(p.qtyOnHand)} {p.baseUnit}</td>
                </tr>
              ))}
              {results.length === 0 && <tr><td><Empty>Nothing matches</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <div className="card card-scroll" style={{ marginTop: 10 }}>
        <table>
          <thead>
            <tr><th>Item</th><th className="r">Quantity</th><th className="r">Rate</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <td>{l.product.name}</td>
                <td className="r">
                  <input className="qty-input num" value={l.qty}
                    onChange={(e) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, qty: e.target.value } : x))} />
                </td>
                <td className="r">
                  <input className="qty-input num" placeholder="list price" value={l.rate}
                    onChange={(e) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, rate: e.target.value } : x))} />
                </td>
                <td className="r">
                  <button className="btn ghost sm" onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}>✕</button>
                </td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={4}><Empty>Nothing added yet</Empty></td></tr>}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
        <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>Roughly</span>
        <Rupees value={rough} />
        <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
          Before tax. A blank rate is filled in from the price list when this is saved.
        </span>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------- the detail --- */

function Detail({ doc, config, canCancel, canWrite, canBill, onClose, onChanged, onError, userId }: {
  doc: DocumentDetail
  config: DeskConfig
  canCancel: boolean
  canWrite: boolean
  canBill: boolean
  onClose: () => void
  onChanged: (message: string) => void
  onError: (message: string | null) => void
  userId: string
}) {
  const { db } = useCore()
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const label = config.labels[doc.kind]!
  const isDraft = doc.docstatus === 0
  const isIssued = doc.docstatus === 1
  const anythingLeft = doc.items.some((i) => i.remainingQty > 0)
  /**
   * Whether anything has been billed or received against this yet.
   *
   * `cancelDocument` refuses outright once any line has been acted on, so
   * offering the button in that state was offering a button that could not
   * work: pressing it opened a box, asked for a reason, took the reason, and
   * then refused. The refusal was correct and arrived three steps too late.
   */
  const untouched = doc.progress === 'open'

  async function print() {
    onError(null)
    const result = await printDocumentSheet(db, doc.id)
    if (!result.ok) onError(result.message)
  }

  async function issue() {
    setBusy(true)
    const result = await submitDocument(db, { documentId: doc.id, actorId: userId })
    setBusy(false)
    if (!result.ok) { onError('That document could not be issued.'); return }
    onChanged(`${label.name} ${doc.docNo} issued.`)
  }

  async function toOrder() {
    setBusy(true)
    const result = await quotationToSalesOrder(db, { quotationId: doc.id, actorId: userId })
    setBusy(false)
    if (!result.ok) {
      onError(
        result.code === 'EXPIRED' ? 'That quotation is past its valid-until date. Raise a fresh one at today’s prices.'
        : result.code === 'NOTHING_LEFT' ? 'Every line on that quotation has already been ordered.'
        : result.code === 'NOT_SUBMITTED' ? 'Issue the quotation first.'
        : 'That quotation could not be turned into an order.',
      )
      return
    }
    onChanged(`Sales order ${result.docNo} raised from ${doc.docNo}, at the quoted rates.`)
  }

  /**
   * Puts what is still outstanding on the counter, at the rates that were
   * promised.
   *
   * It creates nothing. The order is marked off when the bill is paid, not when
   * the cart is loaded — a cashier who is interrupted halfway has delivered
   * nothing, and an order the shop believes it has already sent out is worse
   * than one that says nothing at all.
   */
  async function bill() {
    setBusy(true)
    const result = await documentToCart(db, { documentId: doc.id })
    setBusy(false)
    if (!result.ok) {
      onError(
        result.code === 'EXPIRED' ? 'That quotation is past its valid-until date. Raise a fresh one at today’s prices.'
        : result.code === 'NOTHING_LEFT' ? 'Everything on this has already been billed.'
        : result.code === 'NOT_SUBMITTED' ? 'Issue it first.'
        : 'That could not be put on the counter.',
      )
      return
    }
    /* The counter claims this as it mounts; the shell is what switches to it.
       Closing first so the cashier arrives at the till, not at a dialog. */
    onClose()
    requestRepeat({
      docNo: result.docNo,
      customerId: result.customerId,
      order: { id: result.documentId, docNo: result.docNo },
      lines: result.lines.map((l) => ({
        productId: l.productId,
        saleUnit: l.saleUnit,
        qty: Quantity.toUnits(l.qty),
        rate: l.rate,
      })),
    })
  }

  async function receive() {
    setBusy(true)
    const result = await receivePurchaseOrder(db, { purchaseOrderId: doc.id, actorId: userId })
    setBusy(false)
    if (!result.ok) {
      onError(
        result.code === 'NOTHING_LEFT' ? 'Everything on that order has already been received.'
        : result.code === 'NOT_SUBMITTED' ? 'Issue the order first.'
        : 'Those goods could not be received.',
      )
      return
    }
    onChanged(`Received into stock at the ordered cost.`)
  }

  async function cancel() {
    if (!cancelling?.trim()) return
    setBusy(true)
    const result = await cancelDocument(db, { documentId: doc.id, reason: cancelling.trim(), actorId: userId })
    setBusy(false)
    setCancelling(null)
    if (!result.ok) {
      onError(
        /* Two different situations and two different ways out. Part-done has a
           remainder somebody may still want; all-done has none, and telling a
           shopkeeper that "part of this has been delivered" when all of it has
           sends them looking for a missing part that does not exist. */
        result.code === 'FULLY_FULFILLED'
          ? `Everything on this ${label.name.toLowerCase()} has already been billed, so there is nothing left to cancel.`
        : result.code === 'PARTLY_FULFILLED'
          ? 'Part of this has already been delivered or received, so it cannot be cancelled. Raise a fresh one for the remainder instead.'
        : 'That document could not be cancelled.',
      )
      return
    }
    onChanged(`${label.name} ${doc.docNo} cancelled.`)
  }

  return (
    <Modal
      title={`${label.name} ${doc.docNo}`}
      wide
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn" onClick={() => void print()}>Print</button>
        {isDraft && canWrite && (
          <button className="btn primary" disabled={busy} onClick={() => void issue()}>Issue</button>
        )}
        {isIssued && canCancel && untouched && (
          <button className="btn" disabled={busy} onClick={() => setCancelling('')}>Cancel it</button>
        )}
        {isIssued && anythingLeft && canWrite && doc.kind === 'quotation' && (
          <button className="btn" disabled={busy} onClick={() => void toOrder()}>Make a sales order</button>
        )}
        {isIssued && anythingLeft && canBill && config.party === 'customer' && (
          <button className="btn primary" disabled={busy} onClick={() => void bill()}>Bill it</button>
        )}
        {isIssued && anythingLeft && canWrite && doc.kind === 'purchase_order' && (
          <button className="btn primary" disabled={busy} onClick={() => void receive()}>Receive into stock</button>
        )}
      </>}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 12.5, marginBottom: 10 }}>
        <span><span style={{ color: 'var(--ink-3)' }}>Date </span>{doc.postingDate}</span>
        <span>
          <span style={{ color: 'var(--ink-3)' }}>{config.party === 'supplier' ? 'Supplier ' : 'Customer '}</span>
          {doc.partyName ?? 'Not recorded'}
        </span>
        {doc.validUntil && <span><span style={{ color: 'var(--ink-3)' }}>Valid until </span>{doc.validUntil}</span>}
        <span><DocStatusBadge status={doc.docstatus} /></span>
      </div>

      {doc.cancelReason && <Alert kind="warn">Cancelled: {doc.cancelReason}</Alert>}

      {/* Why the Cancel button is not there, said once, where somebody looking
          for it would look. A control that silently disappears is a control the
          shopkeeper assumes they have lost a permission for. */}
      {isIssued && !untouched && (
        <Alert kind="ok">
          {anythingLeft
            ? `Part of this has been ${config.party === 'supplier' ? 'received' : 'billed'} already, so it can no longer be cancelled. Raise a fresh ${label.name.toLowerCase()} for what is left.`
            : `Everything on this has been ${config.party === 'supplier' ? 'received' : 'billed'}. It is finished, and there is nothing left to cancel.`}
        </Alert>
      )}
      {doc.notes && <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginBottom: 8 }}>{doc.notes}</div>}

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th className="r">Ordered</th>
            <th className="r">{doc.kind === 'purchase_order' ? 'Received' : 'Billed'}</th>
            <th className="r">Left</th>
            <th className="r">Rate</th>
            <th className="r">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.map((i) => (
            <tr key={i.id}>
              <td>{i.productName}<div className="src">{i.saleUnit}</div></td>
              <td className="r num">{Quantity.formatQty(i.qty)}</td>
              <td className="r num">{Quantity.formatQty(i.fulfilledQty)}</td>
              <td className="r num">{Quantity.formatQty(i.remainingQty)}</td>
              <td className="r"><Rupees value={i.rate} /></td>
              <td className="r"><Rupees value={i.lineTotal} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={5} className="r">Total</th>
            <th className="r"><Rupees value={doc.grandTotal} /></th>
          </tr>
        </tfoot>
      </table>

      {cancelling !== null && (
        <div style={{ marginTop: 12 }}>
          <Field label="Why is it being cancelled?" hint="Kept against the document, so the reason is answerable later.">
            <input className="input" id="doc-cancel-reason" autoFocus value={cancelling}
              onChange={(e) => setCancelling(e.target.value)} placeholder="The school went elsewhere" />
          </Field>
          <button className="btn" disabled={busy || cancelling.trim() === ''} onClick={() => void cancel()}>
            Cancel this {label.name.toLowerCase()}
          </button>
        </div>
      )}
    </Modal>
  )
}
