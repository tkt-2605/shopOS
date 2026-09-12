import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Money, Quantity, Tax, Pricing,
  searchProducts, saleUnitsFor, searchCustomers, productsByIds,
  submitBill, loadPriceCandidates, defaultPriceListId,
  type ProductListItem, type CustomerListItem, type SaleUnitOption, type DraftDetail,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { printBill } from '../core/print'
import { useDraftBill, type CartSnapshot } from '../core/useDraftBill'
import { Field, Modal, Empty, Alert, Rupees } from '../ui/components'

interface Line {
  key: string
  product: ProductListItem
  saleUnit: string
  units: SaleUnitOption[]
  qty: number
  rate: number
  source: Pricing.PriceSource
  sourceId: string | null
  manual: boolean
}

export default function Billing() {
  const { db, registerId } = useCore()
  const user = useUser()

  const [term, setTerm] = useState('')
  const [results, setResults] = useState<ProductListItem[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [customer, setCustomer] = useState<CustomerListItem | null>(null)
  const [customers, setCustomers] = useState<CustomerListItem[]>([])
  const [pickingCustomer, setPickingCustomer] = useState(false)
  const [discount, setDiscount] = useState('')
  const [paying, setPaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ billId: string; docNo: string; total: number; points: number } | null>(null)
  const [printMsg, setPrintMsg] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(true)
  const scanRef = useRef<HTMLInputElement>(null)

  const draft = useDraftBill(db, registerId, user.id)

  useEffect(() => { scanRef.current?.focus() }, [])

  useEffect(() => {
    let cancelled = false
    const id = setTimeout(() => {
      void searchProducts(db, { term, limit: 40 }).then((r) => { if (!cancelled) setResults(r) })
    }, term === '' ? 0 : 140)
    return () => { cancelled = true; clearTimeout(id) }
  }, [db, term])

  const fill = useCallback(async (detail: DraftDetail) => {
    const products = await productsByIds(db, detail.lines.map((l) => l.productId))
    const byId = new Map(products.map((p) => [p.id, p]))

    const restored: Line[] = []
    for (const [i, saved] of detail.lines.entries()) {
      const product = byId.get(saved.productId)
      if (!product) continue
      const units = await saleUnitsFor(db, saved.productId)
      restored.push({
        key: `${saved.productId}-${i}-${Date.now()}`,
        product,
        saleUnit: saved.saleUnit,
        units,
        qty: Quantity.toUnits(saved.qty),
        rate: saved.rate,
        source: saved.priceSource as Pricing.PriceSource,
        sourceId: null,
        manual: saved.priceSource === 'manual_override',
      })
    }

    setLines(restored)
    setDiscount(detail.billDiscount > 0 ? Money.format(detail.billDiscount) : '')
    if (detail.customerId) {
      const found = (await searchCustomers(db, detail.customerName ?? '')).find((c) => c.id === detail.customerId)
      setCustomer(found ?? null)
    } else {
      setCustomer(null)
    }
  }, [db])

  // Picks up wherever this counter was when the cashier last looked away.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (draft.billId) {
        const detail = await draft.resume(draft.billId)
        if (detail && !cancelled) await fill(detail)
      }
      if (!cancelled) setRestoring(false)
    })()
    return () => { cancelled = true }
    // Runs once, for the draft this counter was already on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addProduct = useCallback(async (product: ProductListItem) => {
    const units = await saleUnitsFor(db, product.id)
    const unit = units.find((u) => u.isDefault) ?? units[0]!
    const listId = await defaultPriceListId(db)
    const candidates = await loadPriceCandidates(db, {
      productId: product.id,
      saleUnit: unit.saleUnit,
      customerId: customer?.id ?? null,
      customerPriceListId: null,
      defaultPriceListId: listId,
    })
    const resolved = Pricing.resolvePrice(candidates, Quantity.fromUnits(1))

    setLines((prev) => {
      const existing = prev.findIndex((l) => l.product.id === product.id && l.saleUnit === unit.saleUnit && !l.manual)
      if (existing >= 0) {
        const next = [...prev]
        next[existing] = { ...next[existing]!, qty: next[existing]!.qty + 1 }
        return next
      }
      return [...prev, {
        key: `${product.id}-${Date.now()}`,
        product, saleUnit: unit.saleUnit, units, qty: 1,
        rate: resolved.rate, source: resolved.source, sourceId: resolved.sourceId, manual: false,
      }]
    })
    setTerm('')
    scanRef.current?.focus()
  }, [db, customer])

  // A barcode scanner types fast and finishes with Enter. An exact match on the
  // typed value goes straight into the cart without a selection step.
  const onScanKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const exact = results.find((r) => r.barcode === term.trim())
    const pick = exact ?? results[0]
    if (pick) await addProduct(pick)
  }

  const computed = useMemo(() => {
    const rows = lines.map((line) => {
      const unit = line.units.find((u) => u.saleUnit === line.saleUnit)!
      const qty = Quantity.fromUnits(line.qty)
      const gross = Math.round((line.rate * qty) / Quantity.QTY_SCALE)
      return { line, unit, qty, lineTotal: gross }
    })
    const subtotal = rows.reduce((s, r) => s + r.lineTotal, 0)
    const billDiscount = Math.min(Money.parseMoney(discount) ?? 0, subtotal)
    const shares = billDiscount > 0
      ? Money.allocate(billDiscount as never, rows.map((r) => r.lineTotal))
      : rows.map(() => 0)

    let taxTotal = 0
    rows.forEach((r, i) => {
      const net = r.lineTotal - (shares[i] ?? 0)
      taxTotal += Tax.splitTax(net as never, r.line.product.taxRateBp).taxTotal
    })

    const grandTotal = subtotal - billDiscount
    return { rows, subtotal, billDiscount, taxTotal, grandTotal }
  }, [lines, discount])

  const snapshot = useMemo<CartSnapshot>(() => ({
    customerId: customer?.id ?? null,
    billDiscount: computed.billDiscount as never,
    lines: computed.rows.map((r) => ({
      productId: r.line.product.id,
      saleUnit: r.line.saleUnit,
      qty: r.qty,
      ...(r.line.manual ? { rateOverride: r.line.rate as never } : {}),
    })),
  }), [customer, computed])

  // Nothing is saved while the screen is still rebuilding itself, or an empty
  // restored cart would discard the very draft it is loading.
  useEffect(() => {
    if (restoring) return
    draft.touch(snapshot)
  }, [restoring, snapshot, draft])

  function setQty(key: string, value: number) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, qty: Math.max(0.0001, value) } : l)))
  }

  function setRate(key: string, value: string) {
    const rate = Money.parseMoney(value)
    if (rate === null) return
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, rate, manual: true, source: 'manual_override', sourceId: null } : l)))
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key))
  }

  function reset() {
    setLines([]); setCustomer(null); setDiscount(''); setTerm(''); setError(null)
    scanRef.current?.focus()
  }

  async function clearBill() {
    const id = draft.billId
    reset()
    if (id) await draft.discard(id)
  }

  async function holdBill() {
    await draft.hold()
    reset()
  }

  async function resumeBill(billId: string) {
    const detail = await draft.resume(billId)
    if (!detail) { setError('That held bill is no longer there.'); return }
    await fill(detail)
    setTerm('')
    setError(null)
    scanRef.current?.focus()
  }

  async function pay(method: 'cash' | 'upi' | 'card' | 'credit') {
    setError(null)
    if (computed.rows.length === 0) return

    // The bill on screen is already a draft; paying submits that same document,
    // so the number on the receipt belongs to the row that was there all along.
    await draft.flush()
    const billId = draft.billId
    if (!billId) {
      setError('The bill could not be prepared. Try adding the items again.')
      return
    }

    const result = await submitBill(db, {
      billId,
      payments: [{ method, amount: computed.grandTotal as never }],
      actorId: user.id,
    })

    if (!result.ok) {
      setError(submitMessage(result))
      return
    }

    setDone({ billId, docNo: result.docNo, total: computed.grandTotal, points: result.pointsEarned })
    setPrintMsg(null)
    // Print straight away; the dialog stays up so a failed print can be retried.
    void printBill(db, billId).then((r) => { if (!r.ok) setPrintMsg(r.message) })
    setPaying(false)
    draft.release()
    reset()
  }

  return (
    <div className="billing">
      <div className="bill-left">
        {draft.drafts.length > 0 && (
          <div className="held-strip">
            {draft.drafts.map((d, i) => (
              <button
                key={d.billId}
                className="held"
                aria-current={d.billId === draft.billId}
                onClick={() => void resumeBill(d.billId)}
                title={d.preview}
              >
                <span className="n">{i + 1}</span>
                <span className="who">{d.customerName ?? `${d.lineCount} item${d.lineCount === 1 ? '' : 's'}`}</span>
                <span className="amt">{Money.formatWithSymbol(d.grandTotal)}</span>
                <span
                  className="x"
                  role="button"
                  aria-label="Discard this held bill"
                  onClick={(e) => { e.stopPropagation(); void draft.discard(d.billId) }}
                >
                  ✕
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="scan-wrap">
        <div className="scan-bar">
          <input
            ref={scanRef}
            placeholder="Scan a barcode or type to search…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => void onScanKey(e)}
            id="scan"
          />
        </div>

        {term !== '' && (
        <div className="results">
            <table>
              <tbody>
                {results.map((p) => (
                  <tr key={p.id} className="pickable" onClick={() => void addProduct(p)}>
                    <td>
                      <span className="cart-name">{p.name}</span>
                      {p.brand && <span className="cart-brand"> · {p.brand}</span>}
                    </td>
                    <td className="r num" style={{ width: 110 }}>
                      {Quantity.formatQty(p.qtyOnHand)} {p.baseUnit}
                    </td>
                    <td className="r" style={{ width: 100 }}><Rupees value={p.baseRate} /></td>
                  </tr>
                ))}
                {results.length === 0 && (
                  <tr><td colSpan={3}><Empty>Nothing matches “{term}”</Empty></td></tr>
                )}
              </tbody>
            </table>
        </div>
        )}
        </div>

        <div className="cart">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ width: 100 }}>Unit</th>
                <th className="r" style={{ width: 96 }}>Qty</th>
                <th className="r" style={{ width: 110 }}>Rate</th>
                <th className="r" style={{ width: 110 }}>Amount</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {computed.rows.map(({ line, lineTotal }) => (
                <tr key={line.key}>
                  <td>
                    <div>{line.product.name}</div>
                    <div className="src">{Pricing.describeSource(line.source)}</div>
                  </td>
                  <td>
                    <select
                      className="select"
                      value={line.saleUnit}
                      onChange={(e) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, saleUnit: e.target.value } : l)))}
                    >
                      {line.units.map((u) => <option key={u.saleUnit} value={u.saleUnit}>{u.saleUnit}</option>)}
                    </select>
                  </td>
                  <td className="r">
                    <input
                      className="qty-input num"
                      type="number" min="0.0001" step="1"
                      value={line.qty}
                      onChange={(e) => setQty(line.key, Number(e.target.value))}
                    />
                  </td>
                  <td className="r">
                    <input
                      className="qty-input num"
                      defaultValue={Money.format(line.rate as never)}
                      onBlur={(e) => setRate(line.key, e.target.value)}
                    />
                  </td>
                  <td className="r"><Rupees value={lineTotal} /></td>
                  <td>
                    <button className="btn ghost sm" onClick={() => removeLine(line.key)} aria-label="Remove">✕</button>
                  </td>
                </tr>
              ))}
              {computed.rows.length === 0 && (
                <tr><td colSpan={6}><Empty>Scan an item to start a bill</Empty></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bill-right">
        <div className="totals">
          <Field label="Customer">
            <button className="btn" style={{ width: '100%', justifyContent: 'space-between' }}
              onClick={() => { void searchCustomers(db).then(setCustomers); setPickingCustomer(true) }}>
              <span>{customer?.name ?? 'Walk-in'}</span>
              <span style={{ color: 'var(--ink-3)' }}>Change</span>
            </button>
          </Field>
          {customer && customer.outstanding > 0 && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--warn)' }}>
              Outstanding <Rupees value={customer.outstanding} />
            </div>
          )}
        </div>

        <div className="totals">
          {error && <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div>}

          <div className="total-line">
            <span>Subtotal</span><Rupees value={computed.subtotal} />
          </div>
          <div className="total-line">
            <span>Discount</span>
            <input
              className="qty-input num" style={{ width: 110 }}
              placeholder="0.00" value={discount}
              onChange={(e) => setDiscount(e.target.value)}
            />
          </div>
          <div className="total-line" style={{ color: 'var(--ink-3)' }}>
            <span>Tax included</span><Rupees value={computed.taxTotal} />
          </div>
          <div className="total-line grand">
            <span>Total</span><Rupees value={computed.grandTotal} className="amount" />
          </div>
        </div>

        <div className="fkeys">
          <button className="btn" disabled={computed.rows.length === 0} onClick={() => void holdBill()}>
            Hold bill
          </button>
          <button className="btn" disabled={computed.rows.length === 0} onClick={() => void clearBill()}>
            Clear bill
          </button>
        </div>

        <button className="pay-btn" disabled={computed.rows.length === 0} onClick={() => setPaying(true)}>
          <span className="k">F12</span>
          <span>Take payment</span>
        </button>
      </div>

      {pickingCustomer && (
        <Modal title="Choose a customer" onClose={() => setPickingCustomer(false)}>
          <input className="input" placeholder="Search by name or phone"
            onChange={(e) => void searchCustomers(db, e.target.value).then(setCustomers)} />
          <table>
            <tbody>
              <tr className="pickable" onClick={() => { setCustomer(null); setPickingCustomer(false) }}>
                <td><span className="cart-name">Walk-in</span></td><td className="r">—</td>
              </tr>
              {customers.map((c) => (
                <tr key={c.id} className="pickable" onClick={() => { setCustomer(c); setPickingCustomer(false) }}>
                  <td>
                    <span className="cart-name">{c.name}</span>
                    {c.phone && <span className="cart-brand"> · {c.phone}</span>}
                  </td>
                  <td className="r">
                    {c.outstanding > 0 ? <Rupees value={c.outstanding} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

      {paying && (
        <Modal
          title={`Take payment — ${Money.formatWithSymbol(computed.grandTotal as never)}`}
          onClose={() => setPaying(false)}
          footer={<button className="btn" onClick={() => setPaying(false)}>Cancel</button>}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button className="btn primary lg" onClick={() => void pay('cash')}>Cash</button>
            <button className="btn lg" onClick={() => void pay('upi')}>UPI</button>
            <button className="btn lg" onClick={() => void pay('card')}>Card</button>
            <button className="btn lg" disabled={!customer} onClick={() => void pay('credit')}>
              Credit
            </button>
          </div>
          {!customer && <span className="hint">Credit needs a customer on the bill.</span>}
        </Modal>
      )}

      {done && (
        <Modal
          title="Bill complete"
          onClose={() => setDone(null)}
          footer={<>
            <button className="btn" onClick={() => {
              void printBill(db, done.billId).then((r) => setPrintMsg(r.ok ? null : r.message))
            }}>Print again</button>
            <button className="btn primary" onClick={() => setDone(null)}>New bill</button>
          </>}
        >
          <div style={{ fontSize: 15 }}>
            <strong className="num">{done.docNo}</strong>
          </div>
          <div style={{ fontSize: 26, fontWeight: 700 }}><Rupees value={done.total} /></div>
          {done.points > 0 && <Alert kind="ok">{done.points} loyalty points earned</Alert>}
          {printMsg && <Alert kind="warn">{printMsg} The bill is saved — you can print it again.</Alert>}
        </Modal>
      )}
    </div>
  )
}

function draftMessage(code: string): string {
  switch (code) {
    case 'NO_LINES': return 'Add at least one item.'
    case 'UNKNOWN_PRODUCT': return 'One of the items no longer exists.'
    case 'INVALID_QTY': return 'Check the quantities — each must be more than zero.'
    case 'DISCOUNT_EXCEEDS_TOTAL': return 'The discount is larger than the bill.'
    default: return 'The bill could not be prepared.'
  }
}

function submitMessage(result: Extract<Awaited<ReturnType<typeof submitBill>>, { ok: false }>): string {
  switch (result.code) {
    case 'INSUFFICIENT_STOCK': {
      const first = result.shortfalls[0]
      return first
        ? `Not enough stock: ${first.productName} has ${Quantity.formatQty(first.available)}, needs ${Quantity.formatQty(first.required)}.`
        : 'Not enough stock.'
    }
    case 'CREDIT_LIMIT_EXCEEDED':
      return `Over the credit limit by ${Money.formatWithSymbol(result.excess)}. Take a payment first or reduce the bill.`
    case 'PAYMENT_MISMATCH':
      return 'The payment does not match the bill total.'
    case 'CREDIT_WITHOUT_CUSTOMER':
      return 'Choose a customer before billing to credit.'
    case 'LOYALTY_REJECTED':
      return `Points could not be redeemed: ${result.reason}.`
    default:
      return 'The bill could not be completed.'
  }
}
