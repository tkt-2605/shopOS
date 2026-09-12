import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Money, Quantity, Pricing, Totals, Loyalty,
  searchProducts, saleUnitsFor, searchCustomers, loadLoyaltyProgram,
  submitBill, pricingContextFor, resolveLinePrice,
  type ProductListItem, type CustomerListItem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { printBill } from '../core/print'
import { useBillTabs, MAX_TABS, type Cart, type CartLine } from '../core/useBillTabs'
import { Field, Modal, Empty, Alert, Rupees } from '../ui/components'

export default function Billing() {
  const { db, registerId } = useCore()
  const user = useUser()
  const tabs = useBillTabs(db, registerId, user.id)
  const active = tabs.active

  const [term, setTerm] = useState('')
  const [results, setResults] = useState<ProductListItem[]>([])
  const [customers, setCustomers] = useState<CustomerListItem[]>([])
  const [pickingCustomer, setPickingCustomer] = useState(false)
  const [paying, setPaying] = useState(false)
  const [done, setDone] = useState<{ billId: string; docNo: string; total: number; points: number } | null>(null)
  const [printMsg, setPrintMsg] = useState<string | null>(null)
  const [redeemPoints, setRedeemPoints] = useState(0)
  const [program, setProgram] = useState<Loyalty.LoyaltyProgram | null>(null)
  const scanRef = useRef<HTMLInputElement>(null)

  useEffect(() => { void loadLoyaltyProgram(db).then(setProgram) }, [db])

  const focusScan = useCallback(() => scanRef.current?.focus(), [])
  useEffect(() => { focusScan() }, [focusScan, active.tabId])

  useEffect(() => {
    let cancelled = false
    const id = setTimeout(() => {
      void searchProducts(db, { term, limit: 40 }).then((r) => { if (!cancelled) setResults(r) })
    }, term === '' ? 0 : 140)
    return () => { cancelled = true; clearTimeout(id) }
  }, [db, term])

  const totals = useMemo(
    () => Totals.computeTotals(
      active.lines.map((l) => ({
        qty: Quantity.fromUnits(l.qty),
        rate: l.rate as never,
        taxRateBp: l.product.taxRateBp,
      })),
      (Money.parseMoney(active.discount) ?? 0) as never,
    ),
    [active.lines, active.discount],
  )

  const empty = active.lines.length === 0

  /* How many points this bill can absorb: what the customer has, capped by the
     share of the bill the program lets points cover. */
  const redeemable = useMemo(() => {
    const held = active.customer?.loyaltyPoints ?? 0
    if (!program || !program.enabled || held === 0 || totals.grandTotal === 0) return 0
    const cap = Math.floor((totals.grandTotal * program.maxRedeemFractionBp) / 10_000)
    const affordable = program.pointValue > 0 ? Math.floor(cap / program.pointValue) : 0
    return Math.max(0, Math.min(held, affordable))
  }, [active.customer, program, totals.grandTotal])

  const redeemedValue = program && redeemPoints > 0
    ? Loyalty.pointsToMoney(program, redeemPoints, totals.grandTotal)
    : 0
  const due = (totals.grandTotal - redeemedValue) as typeof totals.grandTotal

  /* Resolved through the same core call the service uses, so the rate on screen
     is the rate that gets saved. */
  const addProduct = useCallback(async (product: ProductListItem) => {
    const units = await saleUnitsFor(db, product.id)
    const unit = units.find((u) => u.isDefault) ?? units[0]!
    const context = await pricingContextFor(db, active.customer?.id ?? null)
    const resolved = await resolveLinePrice(db, context, {
      productId: product.id,
      saleUnit: unit.saleUnit,
      qty: Quantity.fromUnits(1),
    })

    tabs.patch((cart) => {
      const at = cart.lines.findIndex(
        (l) => l.product.id === product.id && l.saleUnit === unit.saleUnit && !l.manual,
      )
      if (at >= 0) {
        const lines = [...cart.lines]
        lines[at] = { ...lines[at]!, qty: lines[at]!.qty + 1 }
        return { ...cart, lines, error: null }
      }
      const line: CartLine = {
        key: `${product.id}-${Date.now()}`,
        product,
        saleUnit: unit.saleUnit,
        units,
        qty: 1,
        rate: resolved.rate,
        source: resolved.source,
        sourceId: resolved.sourceId,
        manual: false,
      }
      return { ...cart, lines: [...cart.lines, line], error: null }
    })

    setTerm('')
    focusScan()
  }, [db, active.customer, tabs, focusScan])

  // A barcode scanner types fast and finishes with Enter. An exact match on the
  // typed value goes straight into the cart without a selection step.
  const onScanKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setTerm(''); return }
    if (e.key !== 'Enter') return
    e.preventDefault()
    const exact = results.find((r) => r.barcode === term.trim())
    const pick = exact ?? results[0]
    if (pick) await addProduct(pick)
  }

  const editLine = (key: string, change: (line: CartLine) => CartLine) =>
    tabs.patch((cart) => ({ ...cart, lines: cart.lines.map((l) => (l.key === key ? change(l) : l)) }))

  function setRate(key: string, value: string) {
    const rate = Money.parseMoney(value)
    if (rate === null) return
    editLine(key, (l) => ({ ...l, rate, manual: true, source: 'manual_override', sourceId: null }))
  }

  const pay = useCallback(async (method: 'cash' | 'upi' | 'card' | 'credit') => {
    if (active.lines.length === 0) return

    // The bill on screen is already a draft; paying submits that same document,
    // so the number on the receipt belongs to the row that was there all along.
    await tabs.flush()
    const billId = tabs.active.billId
    if (!billId) {
      tabs.patch((cart) => ({ ...cart, error: 'The bill could not be prepared. Try adding the items again.' }))
      return
    }

    const result = await submitBill(db, {
      billId,
      payments: due > 0 ? [{ method, amount: due }] : [],
      ...(redeemPoints > 0 ? { redeemPoints } : {}),
      actorId: user.id,
    })

    if (!result.ok) {
      tabs.patch((cart) => ({ ...cart, error: submitMessage(result) }))
      return
    }

    setDone({ billId, docNo: result.docNo, total: totals.grandTotal, points: result.pointsEarned })
    setPrintMsg(null)
    // Print straight away; the dialog stays up so a failed print can be retried.
    void printBill(db, billId).then((r) => { if (!r.ok) setPrintMsg(r.message) })
    setPaying(false)
    setRedeemPoints(0)
    tabs.released()
    setTerm('')
    focusScan()
  }, [db, user.id, active.lines.length, tabs, totals.grandTotal, due, redeemPoints, focusScan])

  /* The counter should not need the mouse. Only bound keys are advertised.
     The handler is held in a ref so the listener registers once but always runs
     against the current tabs, rather than re-binding on every render. */
  const onKey = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement

    if (e.key === 'F12') {
      e.preventDefault()
      if (!empty && !done) setPaying(true)
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 't') { e.preventDefault(); tabs.open(); return }
    if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); void closeTab(active); return }
    if (e.ctrlKey && e.key >= '1' && e.key <= String(MAX_TABS)) {
      const target = tabs.tabs[Number(e.key) - 1]
      if (target) { e.preventDefault(); tabs.select(target.tabId) }
      return
    }
    if (e.key === '/' && !typing) { e.preventDefault(); focusScan() }
  }

  const keyHandler = useRef(onKey)
  keyHandler.current = onKey

  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  async function closeTab(cart: Cart) {
    if (cart.lines.length > 0) {
      const label = cart.customer?.name ?? `${cart.lines.length} item${cart.lines.length === 1 ? '' : 's'}`
      if (!window.confirm(`Cancel this bill? ${label} will be discarded.`)) return
    }
    await tabs.close(cart.tabId)
    focusScan()
  }

  return (
    <div className="billing">
      <div className="bill-left">
        <div className="tab-strip">
          {tabs.tabs.map((cart, i) => (
            <div key={cart.tabId} className="tab" aria-current={cart.tabId === active.tabId}>
              <button className="pick" onClick={() => tabs.select(cart.tabId)}>
                <span className="n">{i + 1}</span>
                <span className="who">
                  {cart.customer?.name ?? (cart.lines.length === 0 ? 'New' : 'Walk-in')}
                </span>
              </button>
              {tabs.tabs.length > 1 && (
                <button className="shut" aria-label="Cancel this bill" onClick={() => void closeTab(cart)}>
                  ✕
                </button>
              )}
            </div>
          ))}
          {tabs.tabs.length < MAX_TABS && (
            <button className="tab-add" onClick={tabs.open} title="Another bill (Ctrl+T)">+</button>
          )}
        </div>

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
              {active.lines.map((line, i) => (
                <tr key={line.key}>
                  <td>
                    <div>{line.product.name}</div>
                    <div className="src">{Pricing.describeSource(line.source)}</div>
                  </td>
                  <td>
                    <select
                      className="select"
                      value={line.saleUnit}
                      onChange={(e) => editLine(line.key, (l) => ({ ...l, saleUnit: e.target.value }))}
                    >
                      {line.units.map((u) => <option key={u.saleUnit} value={u.saleUnit}>{u.saleUnit}</option>)}
                    </select>
                  </td>
                  <td className="r">
                    <input
                      className="qty-input num"
                      type="number" min="0.0001" step="1"
                      value={line.qty}
                      onChange={(e) => editLine(line.key, (l) => ({ ...l, qty: Math.max(0.0001, Number(e.target.value)) }))}
                    />
                  </td>
                  <td className="r">
                    <input
                      key={`${line.key}-${line.rate}`}
                      className="qty-input num"
                      defaultValue={Money.format(line.rate as never)}
                      onBlur={(e) => setRate(line.key, e.target.value)}
                    />
                  </td>
                  <td className="r"><Rupees value={totals.lines[i]?.net ?? 0} /></td>
                  <td>
                    <button
                      className="btn ghost sm"
                      aria-label="Remove"
                      onClick={() => tabs.patch((cart) => ({
                        ...cart, lines: cart.lines.filter((l) => l.key !== line.key),
                      }))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
              {empty && (
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
              <span>{active.customer?.name ?? 'Walk-in'}</span>
              <span style={{ color: 'var(--ink-3)' }}>Change</span>
            </button>
          </Field>
          {active.customer && active.customer.outstanding > 0 && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--warn)' }}>
              Outstanding <Rupees value={active.customer.outstanding} />
            </div>
          )}
        </div>

        <div className="totals">
          {active.error && <div style={{ marginBottom: 12 }}><Alert>{active.error}</Alert></div>}

          <div className="total-line">
            <span>Subtotal</span><Rupees value={totals.subtotal} />
          </div>
          <div className="total-line">
            <span>Discount</span>
            <input
              className="qty-input num" style={{ width: 110 }}
              placeholder="0.00" value={active.discount}
              onChange={(e) => tabs.patch((cart) => ({ ...cart, discount: e.target.value }))}
            />
          </div>
          <div className="total-line" style={{ color: 'var(--ink-3)' }}>
            <span>Tax included</span><Rupees value={totals.taxTotal} />
          </div>
          <div className="total-line grand">
            <span>Total</span><Rupees value={totals.grandTotal} className="amount" />
          </div>
        </div>

        <button className="pay-btn" disabled={empty} onClick={() => setPaying(true)}>
          <span className="k">F12</span>
          <span>Take payment</span>
        </button>
      </div>

      {pickingCustomer && (
        <Modal title="Choose a customer" onClose={() => setPickingCustomer(false)}>
          <input
            className="input" autoFocus placeholder="Name, phone or customer code"
            onChange={(e) => void searchCustomers(db, e.target.value).then(setCustomers)}
          />
          <table>
            <tbody>
              <tr
                className="pickable"
                onClick={() => {
                  tabs.patch((cart) => ({ ...cart, customer: null }))
                  setPickingCustomer(false)
                }}
              >
                <td><span className="cart-name">Walk-in</span></td><td className="r">—</td>
              </tr>
              {customers.map((c) => (
                <tr
                  key={c.id}
                  className="pickable"
                  onClick={() => {
                    tabs.patch((cart) => ({ ...cart, customer: c }))
                    setPickingCustomer(false)
                  }}
                >
                  <td>
                    <span className="cart-name">{c.name}</span>
                    {c.code && <span className="cart-brand"> · {c.code}</span>}
                    {c.phone && <span className="cart-brand"> · {c.phone}</span>}
                  </td>
                  <td className="r">
                    {c.loyaltyPoints > 0 && (
                      <span className="badge ok" style={{ marginRight: 7 }}>{c.loyaltyPoints} pts</span>
                    )}
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
          title={`Take payment — ${Money.formatWithSymbol(due)}`}
          onClose={() => { setPaying(false); setRedeemPoints(0) }}
          footer={<button className="btn" onClick={() => { setPaying(false); setRedeemPoints(0) }}>Cancel</button>}
        >
          {redeemable > 0 && (
            <div style={{ padding: '11px 13px', background: 'var(--ok-soft)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12.5, flex: 1 }}>
                  {active.customer!.name} has <strong>{active.customer!.loyaltyPoints} points</strong>.
                  Up to {redeemable} can go against this bill.
                </span>
                <input
                  className="qty-input num" type="number" min={0} max={redeemable}
                  value={redeemPoints}
                  onChange={(e) => setRedeemPoints(Math.max(0, Math.min(redeemable, Number(e.target.value) || 0)))}
                />
                <button className="btn sm" onClick={() => setRedeemPoints(redeemable)}>All</button>
              </div>
              {redeemPoints > 0 && (
                <div style={{ marginTop: 7, fontSize: 12.5, color: 'var(--ink-2)' }}>
                  {redeemPoints} points pay {Money.formatWithSymbol(redeemedValue as never)} — {Money.formatWithSymbol(due)} left.
                </div>
              )}
            </div>
          )}

          {due === 0 ? (
            <button className="btn primary lg" onClick={() => void pay('cash')}>
              Settle with points
            </button>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <button className="btn primary lg" onClick={() => void pay('cash')}>Cash</button>
              <button className="btn lg" onClick={() => void pay('upi')}>UPI</button>
              <button className="btn lg" onClick={() => void pay('card')}>Card</button>
              <button className="btn lg" disabled={!active.customer} onClick={() => void pay('credit')}>
                Credit
              </button>
            </div>
          )}
          {!active.customer && <span className="hint">Credit and loyalty points both need a customer on the bill.</span>}
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
            <button className="btn primary" onClick={() => { setDone(null); focusScan() }}>New bill</button>
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

/** A tab's headline figure, computed the same way as the active cart's. */
function billTotal(cart: Cart): number {
  return Totals.computeTotals(
    cart.lines.map((l) => ({
      qty: Quantity.fromUnits(l.qty),
      rate: l.rate as never,
      taxRateBp: l.product.taxRateBp,
    })),
    (Money.parseMoney(cart.discount) ?? 0) as never,
  ).grandTotal
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
