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
  /**
   * A purchase order's rates as the supplier's bill gives them: before GST,
   * as a quote usually is, or with it in, as a printed bill often shows.
   * Either way the goods go into stock at the price before the tax.
   */
  const [withTax, setWithTax] = useState(false)

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
      : [...prev, { key: `${product.id}-${Date.now()}`, product, qty: '1', rate: '', hint, rateFilled: hint !== null }])
  }

  /** The cost hint as the chosen basis reads it: before GST, or with the item's GST and cess on it. */
  function hinted(l: Line): Money.Money | null {
    if (!l.hint) return null
    if (!withTax) return l.hint.unitCost
    const tax = Tax.addTax(l.hint.unitCost, l.product.taxRateBp, 'intra_state', l.product.cessRateBp).taxTotal
    return (l.hint.unitCost + tax) as Money.Money
  }

  /** What the rate box shows: the filled-in cost, on the chosen basis, or what was typed. */
  function rateText(l: Line): string {
    const filled = l.rateFilled ? hinted(l) : null
    return filled === null ? l.rate : Money.format(filled)
  }

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
    /* To a supplier a blank is what the service will fill in -- the last cost,
       or nothing -- never the shelf price, which is what the shop sells at. */
    const rate = Money.parseMoney(rateText(l)) ?? (forSupplier ? 0 : l.product.baseRate)
    return sum + Math.round(qty * rate)
  }, 0), [lines, withTax, forSupplier])

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
        /* A filled-in cost goes as the figure it was, before GST, whichever
           way it is shown: putting the tax on for the screen and taking it off
           again here could only lose a paisa. */
        if (forSupplier && l.rateFilled && l.hint) {
          return { productId: l.product.id, qty, rateOverride: l.hint.unitCost, rateIncludesTax: false }
        }
        const typed = Money.parseMoney(l.rate)
        return {
          productId: l.product.id,
          qty,
          ...(typed === null ? {} : {
            rateOverride: typed as never,
            ...(forSupplier ? { rateIncludesTax: withTax }
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
        {forSupplier && (
          <Field label="Rates are" hint="As the supplier’s quote or bill gives them. Stock goes in at the price before GST either way.">
            <select className="select" id="doc-rate-basis" value={withTax ? 'with' : 'before'}
              onChange={(e) => setWithTax(e.target.value === 'with')}>
              <option value="before">Before GST</option>
              <option value="with">Including GST</option>
            </select>
          </Field>
        )}
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
                  <input className="qty-input num" placeholder={forSupplier ? '0.00' : 'list price'} value={rateText(l)}
                    onChange={(e) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, rate: e.target.value, rateFilled: false } : x))} />
                  {forSupplier && (l.hint
                    ? <div className="src">{l.rateFilled ? '' : 'was '}{costNote(l.hint)}{withTax && l.rateFilled ? ', with GST' : ''}</div>
                    : rateText(l).trim() === '' && <div className="src warn-note">no cost known — type the supplier’s rate</div>)}
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
          {forSupplier
            ? (withTax ? 'Rates include GST.' : 'Rates are before GST.')
              + ' Each item starts at what it last cost you; type over it to change it.'
            :'Rates are read the way this customer’s price list quotes them. A blank rate is filled in from that list when this is saved.'}
        </span>
      </div>
    </Modal>
  </>)
}
