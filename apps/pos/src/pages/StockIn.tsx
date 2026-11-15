import { useCallback, useEffect, useState } from 'react'
import {
  Money, Quantity, Permissions,
  searchProducts, createStockEntry, submitStockEntry, listSuppliers,
  directionOf, signedQty, noCostBasis, Batches, receivePurchaseOrder,
  loadEntryToEdit, saveStockEntryDraft, amendStockEntry,
  type ProductListItem, type StockEntryType, type Supplier, Tax,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { useConfirm } from '../ui/useConfirm'
import { retryBelowCost } from '../ui/belowCost'
import { useAction } from '../core/useAction'
import { Field, Empty, Alert, Rupees } from '../ui/components'
import { Attachments } from '../ui/Attachments'
import { usePickList } from '../ui/PickList'
import { useSearch } from '../ui/useSearch'
import { useScanChoice, codeOnSeveral } from '../ui/ScanChoice'
import { costOf, costPair, ownPrice, type Line } from './stockIn/cells'
import type { Side } from '../ui/gstPair'
import { useGstMode } from '../ui/GstSwitch'
import { StockInViews, type OpenRequest } from './stockIn/PastEntries'
import { LinesTable } from './stockIn/LinesTable'
import { EditingBanner, editRefusal, linesFromEntry, type Editing } from './stockIn/editing'
import { EntryKindField, SupplierField } from './stockIn/header'
import { takeOrderToReceive } from '../core/nav'
import {
  blankLine, orderLines, receivedLines, leftOnOrder, receiveRefusal, refusalMessage, ReceivingBanner,
} from './stockIn/order'

/** Stock In: a new entry, and every entry made (`stockIn/PastEntries.tsx`). */
export default function StockIn() {
  return <StockInViews renderNew={(open, onSaved) => <NewEntry open={open} onSaved={onSaved} />} />
}

function NewEntry({ open, onSaved }: {
  /** An entry from the list to open in this form: a draft to finish, or a posted one to correct. */
  open: OpenRequest | null
  /** Something the list shows has changed. */
  onSaved: () => void
}) {
  const { db, features, taxScheme } = useCore()
  const [confirmUi, ask] = useConfirm()
  const user = useUser()
  /* The Stock In page used to check nothing, so unticking "submit" on a role
     changed nothing here. The service refuses it now; the button says so first. */
  const canPost = Permissions.can(user.permissions, 'stock_entry', 'submit')
  const batched = features.batchExpiry
  const [entryType, setEntryType] = useState<StockEntryType>('purchase')
  const [supplierId, setSupplierId] = useState('')
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [reference, setReference] = useState('')
  /* A purchase is the supplier's bill (065): its number and date as printed,
     and their rounding, so what is owed is what they billed. */
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [roundOff, setRoundOff] = useState('')
  const [term, setTerm] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState<string | null>(null)
  // A second press while the first is posting would receive the goods twice.
  const posting = useAction(setError)
  // Held with its id, not just its number: the distributor's paper bill is in
  // the shopkeeper's hand at this moment and nowhere else later.
  const [done, setDone] = useState<{ docNo: string; entryId: string } | null>(null)
  /* Items the shop has never recorded a rate for. Read once, because it
     answers a question about history that this screen is not changing until
     it saves — and the difference it makes is which of two warnings is true,
     not whether to warn. */
  const [unpriced, setUnpriced] = useState<Set<string>>(new Set())
  const [gstMode, setGstMode] = useGstMode()
  /**
   * The purchase order this entry is receiving, handed over by "Receive into
   * stock" on the order. While it is set the entry is that order's delivery:
   * a purchase, from its supplier, and posting it marks the order off.
   */
  const [order, setOrder] = useState<{ id: string; docNo: string } | null>(null)
  /** What posting a delivery left open on its order, said once beside the posted note. */
  const [orderNote, setOrderNote] = useState<string | null>(null)
  /** The saved entry this form holds, when it holds one: see `stockIn/editing.tsx`. */
  const [editing, setEditing] = useState<Editing | null>(null)

  const search = useSearch(term, (t) => searchProducts(db, { term: t, limit: 25 }))
  const results = search.rows

  const loadSuppliers = useCallback(async () => {
    setSuppliers(await listSuppliers(db))
  }, [db])

  useEffect(() => { void loadSuppliers() }, [loadSuppliers])

  useEffect(() => {
    void noCostBasis(db).then((rows) => setUnpriced(new Set(rows.map((r) => r.productId))))
  }, [db])

  /* Claimed once, on mount: the order that sent the person here. */
  useEffect(() => {
    const id = takeOrderToReceive()
    if (id) void loadOrder(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (open) void loadEntry(open.entryId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function loadEntry(id: string) {
    setError(null)
    const entry = await loadEntryToEdit(db, id)
    if (!entry || entry.docstatus === 2) { setError('That entry was cancelled, so there is nothing to change.'); return }
    if (entry.docstatus === 1 && entry.locked) { setError(editRefusal({ ok: false, code: entry.locked }, [])); return }
    const { lines: loaded, missing } = await linesFromEntry(db, entry, batched)
    setOrder(null)
    setEntryType(entry.entryType)
    setSupplierId(entry.supplierId ?? '')
    setReference(entry.reference ?? '')
    setInvoiceNo(entry.supplierInvoiceNo ?? '')
    setInvoiceDate(entry.supplierInvoiceDate ?? '')
    setRoundOff(entry.roundOff !== 0 ? Money.format(entry.roundOff) : '')
    setLines(loaded)
    setEditing({ id: entry.id, docNo: entry.docNo, docstatus: entry.docstatus })
    setDone(null)
    setOrderNote(null)
    if (missing > 0) setError('An item on this entry is no longer in the catalogue, and was left off.')
  }

  async function loadOrder(id: string) {
    const loaded = await orderLines(db, id, batched)
    if (!loaded.ok) { setError(loaded.message); return }
    const { order: o } = loaded
    setEntryType('purchase')
    setSupplierId(o.supplierId ?? '')
    setReference(o.docNo)
    setLines(o.lines)
    setOrder({ id: o.id, docNo: o.docNo })
    setEditing(null)
    setDone(null)
    setOrderNote(null)
  }

  async function add(product: ProductListItem) {
    setTerm('')
    // One delivery can carry two batches of one item, so with batches on the
    // same item may be added again, once per batch.
    const line = await blankLine(db, product, batched)
    setLines((prev) => {
      if (!batched && prev.some((l) => l.product.id === product.id)) return prev
      /* A second batch of an item the order asked for counts against the
         same order line, at the order's cost; anything else is goods the
         order never asked for, coming in on the same bill. */
      const sibling = order ? prev.find((l) => l.orderLine && l.product.id === product.id) : undefined
      return [...prev, sibling
        ? { ...line, qty: '0', cost: sibling.cost, costSide: sibling.costSide, costFilled: false,
            gst: sibling.gst, cess: sibling.cess, orderLine: sibling.orderLine! }
        : line]
    })
  }

  /** Whether this line takes stock off, once the kind of entry and its sign have had their say. */
  const outgoing = (l: Line) => signedQty(entryType, Quantity.fromUnits(Number(l.qty) || 0)) < 0
  /** The cost the line will be posted with, before GST -- see `costOf`. */
  const costText = (l: Line) => costOf(l, outgoing(l))
  /** How costs are typed and shown: the switch, on a purchase; before GST on anything else, which carries none. */
  const costMode: Side = entryType === 'purchase' ? gstMode : 'before'
  /** What the cost box shows: the line's cost the way the switch reads, blank where `costOf` drops it. */
  const shownCost = (l: Line) => (outgoing(l) && l.costFilled ? '' : costPair(l)[costMode])
  /** A cost typed in the box: kept as typed, on the side the switch is on, and no longer the filled-in one. */
  const typeCost = (l: Line, side: Side, text: string) => setLines((prev) => prev.map((x) =>
    x.key === l.key ? { ...x, cost: text, costSide: side, costFilled: false } : x))

  const totalCost = lines.reduce((sum, l) => {
    const qty = Number(l.qty) || 0
    const cost = Money.parseMoney(costText(l)) ?? 0
    return sum + Math.round(qty * cost)
  }, 0)

  const purchase = entryType === 'purchase'
  /* Only where goods certainly come in: a price is a fact about packs arriving. */
  const incoming = directionOf(entryType) === 'in'
  const pct = (typed: string) => Math.round((Number(typed) || 0) * 100)
  /** The tax on a line as the bill will carry it -- the same arithmetic as the service, CGST and SGST each rounded. */
  const taxOf = (l: Line) => Tax.addTax(
    Math.round(Math.abs(Number(l.qty) || 0) * (Money.parseMoney(costText(l)) ?? 0)) as never,
    pct(l.gst), 'intra_state', pct(l.cess),
  ).taxTotal
  const totalTax = purchase ? lines.reduce((sum, l) => sum + taxOf(l), 0) : 0
  const rounding = purchase ? Money.parseMoney(roundOff) ?? 0 : 0
  const showCess = purchase && lines.some((l) => l.cess.trim() !== '')

  async function submit(asDraft = false) {
    await posting.run(() => post(asDraft))
  }

  async function post(asDraft: boolean) {
    setError(null)
    setOrderNote(null)
    if (lines.some((l) => (Money.parseMoney(costText(l)) ?? 0) < 0)) {
      setError('A cost cannot be below zero.')
      return
    }
    const expiries: (string | null)[] = []
    for (const l of lines) {
      const parsed = batched && !outgoing(l) ? Batches.parseExpiry(l.expiry) : { ok: true as const, value: null }
      if (!parsed.ok) {
        setError(`The expiry for ${l.product.name} is not a date. Type it as on the pack, like 03/2027.`)
        return
      }
      expiries.push(parsed.value)
    }
    if (purchase && lines.some((l) => !Number.isFinite(Number(l.gst || '0')) || !Number.isFinite(Number(l.cess || '0')))) {
      setError('A GST or cess rate is not a number.')
      return
    }
    if (purchase && roundOff.trim() !== '' && Money.parseMoney(roundOff) === null) {
      setError('The round-off is not an amount. Put a minus in front of it if the bill was rounded down.')
      return
    }
    if (order) {
      await receive(order, expiries)
      return
    }
    const input = (allowBelowCost: boolean) => ({
      entryType,
      supplierId: supplierId || null,
      supplierName: suppliers.find((x) => x.id === supplierId)?.name ?? null,
      reference: reference.trim(),
      ...(purchase ? {
        supplierInvoiceNo: invoiceNo.trim() || null,
        supplierInvoiceDate: invoiceDate || null,
        roundOff: rounding as never,
      } : {}),
      lines: lines.map((l, i) => ({
        productId: l.product.id,
        ...(batched && l.batchNo.trim() !== '' ? { batchNo: l.batchNo, expiryDate: expiries[i] ?? null } : {}),
        /* As typed. `createStockEntry` applies the direction, so this screen
           and any other way in agree without each having to remember it. */
        qty: Quantity.fromUnits(Number(l.qty) || 0),
        unitCost: (Money.parseMoney(costText(l)) ?? 0) as never,
        ...ownPrice(l),
        ...(purchase ? { taxRateBp: pct(l.gst), cessRateBp: pct(l.cess) } : {}),
      })),
      ...(allowBelowCost ? { allowBelowCost } : {}),
      actorId: user.id,
    })
    const draftId = editing?.docstatus === 0 ? editing.id : null

    if (asDraft) {
      const kept = await retryBelowCost((allow) => saveStockEntryDraft(db, { ...input(allow), draftId }), ask, setError)
      if (kept === null) return
      if (!kept.ok) { setError(editRefusal(kept, lines)); return }
      cleared('Saved as a draft. Nothing has touched the stock yet: open it from Past entries, Drafts, to finish it.')
      return
    }
    if (editing?.docstatus === 1) {
      const fixed = await retryBelowCost((allow) => amendStockEntry(db, { ...input(allow), entryId: editing.id }), ask, setError)
      if (fixed === null) return
      if (!fixed.ok) { setError(editRefusal(fixed, lines)); return }
      posted(fixed.docNo, fixed.entryId)
      setOrderNote(`It corrects ${fixed.replaced}, which is kept on the list, cancelled.`)
      return
    }

    // A price given to these goods below what they cost: see `ui/belowCost.ts`.
    const entry = draftId
      ? await retryBelowCost((allow) => saveStockEntryDraft(db, { ...input(allow), draftId }), ask, setError)
      : await retryBelowCost((allow) => createStockEntry(db, input(allow)), ask, setError)
    if (entry === null) return

    if (!entry.ok) {
      setError(entry.code === 'NOT_A_DRAFT' ? editRefusal(entry, lines) : refusalMessage(entry))
      return
    }

    const submitted = await submitStockEntry(db, { entryId: entry.entryId, actorId: user.id })
    if (!submitted.ok) {
      setError(refusalMessage(submitted))
      return
    }

    posted(submitted.docNo, entry.entryId)
  }

  /**
   * The delivery against the order: one call that puts the goods in and marks
   * the order off together, so neither can happen without the other.
   */
  async function receive(on: { id: string; docNo: string }, expiries: (string | null)[]) {
    const attempt = (allowBelowCost: boolean) => receivePurchaseOrder(db, {
      purchaseOrderId: on.id,
      supplierInvoiceNo: invoiceNo.trim() || null,
      supplierInvoiceDate: invoiceDate || null,
      roundOff: rounding as never,
      lines: receivedLines(lines, costText, expiries, batched),
      ...(allowBelowCost ? { allowBelowCost } : {}),
      actorId: user.id,
    })
    const result = await retryBelowCost(attempt, ask, setError)
    if (result === null) return
    if (!result.ok) { setError(receiveRefusal(result, on.docNo, lines)); return }
    posted(result.docNo, result.stockEntryId)
    setOrder(null)
    setSupplierId('')
    setOrderNote(await leftOnOrder(db, on.id, on.docNo))
  }

  function posted(docNo: string, entryId: string) {
    cleared(null)
    setDone({ docNo, entryId })
  }

  /** The form emptied after a save, ready for the next entry. */
  function cleared(note: string | null) {
    setDone(null)
    setOrderNote(note)
    setEditing(null)
    onSaved()
    setLines([])
    setReference('')
    setInvoiceNo('')
    setInvoiceDate('')
    setRoundOff('')
  }

  /** Lets go of the order: the entry becomes an ordinary one, and the order stays as it was. */
  function stopReceiving() {
    setOrder(null)
    setLines((prev) => prev.map(({ orderLine: _, ...rest }) => rest))
    setReference('')
  }

  const scanChoice = useScanChoice((p) => void add(p))
  const pick = usePickList({
    count: results.length,
    resetKey: term,
    onPick: (i) => { const hit = results[i]; if (hit && !scanChoice.askFamily(hit)) void add(hit) },
    enter: async () => {
      const typed = term.trim()
      const rows = await search.latest()
      // One code on several items (069): received into the one somebody picks, never the first.
      if (scanChoice.ask(rows, typed)) return
      const [hit] = rows
      if (hit) return scanChoice.askFamily(hit) ? setTerm('') : add(hit)
      setTerm('')
      setError(`Nothing in the catalog matches ${typed}.`)
    },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 900 }}>
      {scanChoice.dialog}
      {confirmUi}
      {error && <Alert>{error}</Alert>}
      {done && (
        <div>
          <Alert kind="ok">Posted as {done.docNo}. Stock updated.{orderNote ? ` ${orderNote}` : ''}</Alert>
          <Attachments
            entity="stock_entry"
            entityId={done.entryId}
            canEdit
            label={`Supplier's bill for ${done.docNo}`}
          />
        </div>
      )}

      {order && <ReceivingBanner docNo={order.docNo} onStop={stopReceiving} />}
      {editing && <EditingBanner editing={editing} onStop={() => cleared(null)} />}
      {!done && orderNote && <Alert kind="ok">{orderNote}</Alert>}

      <div className="card">
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <EntryKindField value={entryType} locked={order !== null || editing?.docstatus === 1} onChange={setEntryType} />
          <SupplierField suppliers={suppliers} value={supplierId} locked={order !== null} purchase={purchase}
            onChange={setSupplierId} onAdded={(id) => void loadSuppliers().then(() => setSupplierId(id))} />
          {purchase ? (
            <>
              <Field label="Supplier’s bill no.">
                <input className="input" id="invoice-no" value={invoiceNo} maxLength={40}
                  onChange={(e) => setInvoiceNo(e.target.value)} />
              </Field>
              <Field label="Bill date">
                <input className="input" id="invoice-date" type="date" value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)} />
              </Field>
            </>
          ) : (
            <Field label="Reference">
              <input className="input" id="reference" value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          )}
        </div>
      </div>

      <input className="input" placeholder="Scan or search an item to add" value={term}
        onChange={(e) => setTerm(e.target.value)} id="stock-search"
        onKeyDown={pick.searchKeyDown} />

      {term !== '' && !codeOnSeveral(search) && (
        <div className="card" style={{ maxHeight: 220, overflow: 'auto' }}>
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

      <LinesTable lines={lines} setLines={setLines} entryType={entryType} batched={batched} incoming={incoming}
        purchase={purchase} showCess={showCess} gstMode={gstMode} setGstMode={setGstMode} costMode={costMode}
        order={order} unpriced={unpriced} taxScheme={taxScheme} outgoing={outgoing} costText={costText}
        shownCost={shownCost} typeCost={typeCost} taxOf={taxOf} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{purchase ? 'Value excl. GST' : 'Total value'}</span>
        <Rupees value={totalCost} />
        {purchase ? (
          <>
            <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>Tax</span>
            <Rupees value={totalTax} />
            <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>Round off</span>
            <input className="qty-input num" style={{ width: 70 }} placeholder="0.00" value={roundOff}
              onChange={(e) => setRoundOff(e.target.value)} />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>Bill total</span>
            <Rupees value={totalCost + totalTax + rounding} />
          </>
        ) : (
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
            Unit cost is recorded per movement, so valuation stays correct later.
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!order && editing?.docstatus !== 1 && (
          <button className="btn" disabled={lines.length === 0 || posting.busy} onClick={() => void submit(true)}>
            {editing ? 'Save draft' : 'Save as draft'}
          </button>
        )}
        <button
          className="btn primary"
          disabled={!canPost || lines.length === 0 || posting.busy}
          title={canPost ? undefined : 'Your role cannot post stock entries'}
          onClick={() => void submit()}
        >
          {posting.busy ? 'Posting…' : editing?.docstatus === 1 ? 'Save correction' : 'Post entry'}
        </button>
      </div>
    </div>
  )
}
