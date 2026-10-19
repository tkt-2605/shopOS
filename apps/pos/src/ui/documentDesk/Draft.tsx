import { useEffect, useMemo, useState } from 'react'
import {
  Money, Quantity, Tax, searchProducts, searchCustomers, listSuppliers, createDocument, submitDocument, costHint,
  type ProductListItem, type CustomerListItem, type Supplier, type DocumentKind, pricingContextFor,
} from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Field, Modal, Empty, Rupees } from '../components'
import { usePickList } from '../PickList'
import { useSearch } from '../useSearch'
import { useScanChoice } from '../ScanChoice'
import type { DeskConfig, Line } from './types'
import { costNote } from '../costNote'
import { pairOf, type Side } from '../gstPair'
import { GstSwitch, useGstMode } from '../GstSwitch'

export function Draft({ config, kind, onClose, onDone, onError, registerId, userId }: {
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
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const forSupplier = config.party === 'supplier'
  /** How a purchase order's rates are typed and shown: before GST, or with it (`GstSwitch`). */
  const [gstMode, setGstMode] = useGstMode()

  const label = config.labels[kind]!

  const search = useSearch(term, (t) => searchProducts(db, { term: t, limit: 25 }))
  const results = search.rows

  useEffect(() => {
    if (config.party === 'supplier') void listSuppliers(db).then(setSuppliers)
    else void searchCustomers(db, '', 200).then(setCustomers)
  }, [db, config.party])

  async function add(product: ProductListItem) {
    setTerm('')
    // To a supplier, an item starts at what it last cost the shop, not empty.
    const hint = forSupplier ? await costHint(db, product.id) : null
    setLines((prev) => prev.some((l) => l.product.id === product.id)
      ? prev
      : [...prev, {
          key: `${product.id}-${Date.now()}`, product, qty: '1',
          rate: hint ? Money.format(hint.unitCost) : '', rateSide: 'before', hint, rateFilled: hint !== null,
        }])
  }

  /** A purchase order line's rate both ways, at the item's GST and cess (`gstPair.ts`). */
  const ratePair = (l: Line) => pairOf(l.rate, l.rateSide ?? 'before', l.product.taxRateBp, l.product.cessRateBp)

  /** A rate typed in one of the two boxes: kept as typed, on that side, and no longer the filled-in one. */
  const typeRate = (l: Line, side: Side, text: string) => setLines((prev) => prev.map((x) =>
    x.key === l.key ? { ...x, rate: text, rateSide: side, rateFilled: false } : x))

  const scanChoice = useScanChoice(add)
  const pick = usePickList({
    count: results.length,
    resetKey: term,
    onPick: (i) => { const hit = results[i]; if (hit) add(hit) },
    enter: async () => {
      const typed = term.trim()
      const rows = await search.latest()
      if (scanChoice.ask(rows, typed)) return
      const [hit] = rows
      if (hit) return add(hit)
      setTerm('')
      onError(`Nothing in the catalog matches ${typed}.`)
    },
  })

  /* A rough figure, before tax and before the price list has been consulted.
     The real total is computed by the service through the same resolver the
     counter uses, and replaces this the moment the document is saved. */
  const rough = useMemo(() => lines.reduce((sum, l) => {
    const qty = Number(l.qty) || 0
    /* To a supplier, before GST whichever box was typed in, and a blank is what
       the service will fill in -- the last cost, or nothing -- never the shelf
       price, which is what the shop sells at. */
    const rate = forSupplier
      ? pairOf(l.rate, l.rateSide ?? 'before', l.product.taxRateBp, l.product.cessRateBp).beforeValue ?? 0
      : Money.parseMoney(l.rate) ?? l.product.baseRate
    return sum + Math.round(qty * rate)
  }, 0), [lines, forSupplier])

  async function save(issue: boolean) {
    if (!registerId) { onError('This machine is not set to a counter yet. Settings → Set up → Counters.'); return }
    setBusy(true)
    onError(null)

    /* A typed rate is read the way this party's rates are quoted: a supplier's
       before tax (the service's own default for a purchase order), and a
       customer's the way their list quotes -- a wholesale customer's typed 100
       is 100 plus GST, a walk-in's is 100. */
    let typedIncludesTax: boolean | undefined
    if (config.party !== 'supplier') {
      const pricing = await pricingContextFor(db, partyId || null)
      typedIncludesTax = pricing.customerPriceListId
        ? pricing.customerListIncludesTax
        : pricing.defaultListIncludesTax
    }

    const made = await createDocument(db, {
      kind,
      registerId,
      ...(config.party === 'supplier'
        ? { supplierId: partyId || null }
        : { customerId: partyId || null }),
      lines: lines.map((l) => {
        const qty = Quantity.fromUnits(Number(l.qty) || 0)
        /* To a supplier, the figure in the box that was typed in, saying which
           box it was: the service takes a with-GST rate apart itself, exactly,
           so nothing is worked out twice and no paisa is lost. A filled-in cost
           was typed in nobody's box, and goes as what it is, before GST. */
        const typed = Money.parseMoney(l.rate)
        return {
          productId: l.product.id,
          qty,
          ...(typed === null ? {} : {
            rateOverride: typed as never,
            ...(forSupplier ? { rateIncludesTax: l.rateSide === 'with' }
              : typedIncludesTax === undefined ? {} : { rateIncludesTax: typedIncludesTax }),
          }),
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

  return (<>
    {scanChoice.dialog}
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
            <tr>
              <th>Item</th><th className="r">Quantity</th>
              <th className="r">
                Rate
                {forSupplier && <div><GstSwitch mode={gstMode} onChange={setGstMode} /></div>}
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <td>{l.product.name}</td>
                <td className="r">
                  <input className="qty-input num" value={l.qty}
                    onChange={(e) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, qty: e.target.value } : x))} />
                </td>
                {forSupplier ? (
                  /* One box, read the way the switch in the header says; flip it
                     and the same rate is shown the other way. Stock goes in at
                     the price before GST whichever way it was typed. */
                  <td className="r">
                    <input className="qty-input num" placeholder="0.00" aria-label="Rate"
                      value={ratePair(l)[gstMode]} onChange={(e) => typeRate(l, gstMode, e.target.value)} />
                    {l.hint
                      ? <div className="src">{l.rateFilled ? '' : 'was '}{costNote(l.hint)}</div>
                      : l.rate.trim() === '' && <div className="src warn-note">no cost known — type the supplier’s rate</div>}
                    {gstMode === 'with' && (
                      <div className="src">{l.product.taxRateBp === 0 && l.product.cessRateBp === 0
                        ? 'no GST on this item'
                        : `with GST at ${Tax.bpToPercent(l.product.taxRateBp)}%${l.product.cessRateBp ? ` and cess at ${Tax.bpToPercent(l.product.cessRateBp)}%` : ''}`}</div>
                    )}
                  </td>
                ) : (
                  <td className="r">
                    <input className="qty-input num" placeholder="list price" value={l.rate}
                      onChange={(e) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, rate: e.target.value } : x))} />
                  </td>
                )}
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
          {forSupplier
            ? 'Before GST. Switch Excl./Incl. GST to type rates the way the supplier gives them; each item starts at what it last cost you.'
            :'Rates are read the way this customer’s price list quotes them. A blank rate is filled in from that list when this is saved.'}
        </span>
      </div>
    </Modal>
  </>)
}
