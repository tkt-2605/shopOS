import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Money, Quantity, Pricing, Totals, Loyalty, Permissions,
  searchProducts, saleUnitsFor, searchCustomers, loadLoyaltyProgram,
  submitBill, pricingContextFor, resolveLinePrice,
  type ProductListItem, type CustomerListItem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { printBill } from '../core/print'
import { useBillTabs, MAX_TABS, type Cart, type CartLine } from '../core/useBillTabs'
import { useShortcuts } from '../core/useShortcuts'
import { Field, Modal, Empty, Alert, Rupees } from '../ui/components'
import { usePickList, Results } from '../ui/PickList'

export default function Billing() {
  const { db, registerId, stockPolicy, rounding } = useCore()
  const user = useUser()
  const tabs = useBillTabs(db, registerId, user.id)
  const active = tabs.active
  const canOverridePrice = Permissions.can(user.permissions, 'price_list', 'write')

  const [term, setTerm] = useState('')
  const [results, setResults] = useState<ProductListItem[]>([])
  const [customers, setCustomers] = useState<CustomerListItem[]>([])
  const [customerTerm, setCustomerTerm] = useState('')
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

  /* The shop's rounding rule, applied here as well as in the service. The
     cashier is looking at this number while the customer hands over the money,
     so it has to be the number the bill will carry — not a near miss the
     receipt then corrects. */
  const totals = useMemo(
    () => Totals.computeTotals(
      totalsLinesOf(active.lines),
      (Money.parseMoney(active.discount) ?? 0) as never,
      'intra_state',
      rounding,
    ),
    [active.lines, active.discount, rounding],
  )

  /* Lines the shop sells at a few rupees a unit. The discount box has to say so,
     because a cashier typing ₹50 off a bill that is mostly recharge will
     otherwise see a number that does not happen. */
  const blocked = active.lines.filter((l) => l.product.discountBlocked)

  const empty = active.lines.length === 0
  /* A line left at zero is half-typed, not a sale. Said rather than silently
     billed for nothing. */
  const unfinished = active.lines.some((l) => l.qty <= 0)

  /**
   * Lines being sold off a shelf that does not have them.
   *
   * Read off the snapshot the search returned rather than asked of the database
   * on every keystroke: this is a warning, and the authoritative check still
   * happens inside `submitBill` where it belongs. Several lines of the same item
   * are added together, because two lines of three pens is six pens.
   */
  const short = useMemo(() => {
    const wanted = new Map<string, { name: string; unit: string; want: number; have: number }>()
    for (const line of active.lines) {
      if (!line.product.isStockTracked) continue
      const factor = line.units.find((u) => u.saleUnit === line.saleUnit)?.baseUnits
      const base = line.qty * Quantity.toUnits(factor ?? Quantity.fromUnits(1))
      const at = wanted.get(line.product.id)
      if (at) at.want += base
      else {
        wanted.set(line.product.id, {
          name: line.product.name,
          unit: line.product.baseUnit,
          want: base,
          have: Quantity.toUnits(line.product.qtyOnHand),
        })
      }
    }
    for (const [id, w] of wanted) if (w.want <= w.have) wanted.delete(id)
    return wanted
  }, [active.lines])

  const sellingShort = short.size > 0 && stockPolicy === 'warn'

  /**
   * Whether the cashier has said they meant it.
   *
   * Not a second dialog on top of the payment dialog — at a counter with a queue
   * that is the exact friction this product exists to avoid. Instead the money
   * buttons are simply not available until the shortfall is acknowledged, so the
   * warning is something you act on rather than something you read past. Keyed on
   * what is short, so changing the cart withdraws the acknowledgement rather than
   * carrying it over to a different mistake.
   */
  const [acknowledged, setAcknowledged] = useState('')
  const shortKey = useMemo(
    () => [...short.values()].map((w) => `${w.name}:${w.want}`).join('|'),
    [short],
  )
  const blockedOnShort = sellingShort && acknowledged !== shortKey

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
    // Typed three letters and several things match: ↓ goes into the list rather
    // than forcing a reach for the mouse.
    if (e.key === 'ArrowDown' && results.length > 0) {
      e.preventDefault()
      resultPick.focusList()
      return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    const exact = results.find((r) => r.barcode === term.trim())
    const pick = exact ?? results[0]
    if (pick) await addProduct(pick)
  }

  /* The two lists a cashier chooses from. Enter on the scan box is deliberately
     not the list's Enter: an exact barcode beats whatever is highlighted, which
     is what makes a scanner feel instant. */
  /* The scan bar, not the input inside it: the list is as wide as the bar. */
  const scanBox = useRef<HTMLDivElement>(null)

  const resultPick = usePickList({
    count: results.length,
    resetKey: term,
    onPick: (i) => { const p = results[i]; if (p) void addProduct(p) },
  })

  /* Walk-in is row zero, so the commonest answer is the one already highlighted
     when the dialog opens. */
  const chooseCustomer = useCallback((customer: CustomerListItem | null) => {
    tabs.patch((cart) => ({ ...cart, customer }))
    setPickingCustomer(false)
  }, [tabs])

  const customerPick = usePickList({
    count: customers.length + 1,
    resetKey: customerTerm,
    onPick: (i) => chooseCustomer(i === 0 ? null : customers[i - 1] ?? null),
  })

  const editLine = (key: string, change: (line: CartLine) => CartLine) =>
    tabs.patch((cart) => ({ ...cart, lines: cart.lines.map((l) => (l.key === key ? change(l) : l)) }))

  /**
   * Retyping a rate at the counter is a permission, not a given.
   *
   * A shop that has gone to the trouble of setting tiers and customer rates does
   * not want a cashier quietly undoing them one bill at a time — and one that
   * bargains over every sale wants exactly this. It is the same capability that
   * lets someone set prices in the first place.
   */
  function setRate(key: string, value: string) {
    if (!canOverridePrice) return
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
     Every one of these now stands down while a dialog is open — the payment
     sheet used to be reachable with F12 from inside the customer picker, and
     Ctrl+W would cancel the bill behind whatever was on screen. */
  useShortcuts([
    // Allowed while typing: the cashier is often in the quantity box when the
    // customer is ready to pay.
    { key: 'F12', whileTyping: true, run: () => { if (!empty && !unfinished && !done) setPaying(true) } },
    { key: 't', ctrl: true, whileTyping: true, run: () => tabs.open() },
    { key: 'w', ctrl: true, whileTyping: true, run: () => void closeTab(active) },
    ...Array.from({ length: MAX_TABS }, (_, i) => ({
      key: String(i + 1),
      ctrl: true,
      whileTyping: true,
      run: () => {
        const target = tabs.tabs[i]
        if (target) tabs.select(target.tabId)
      },
    })),
    // Not while typing: a cashier searching for "Tuf 1/2" is not asking to jump
    // back to the scan box.
    { key: '/', run: focusScan },
  ])

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

        {tabs.notice && (
          <div style={{ padding: '0 0 10px' }}>
            <Alert kind="ok">
              {tabs.notice}
              <button
                className="btn ghost sm"
                style={{ marginLeft: 10 }}
                onClick={tabs.dismissNotice}
              >Dismiss</button>
            </Alert>
          </div>
        )}

        <div className="scan-wrap">
          <div className="scan-bar" ref={scanBox}>
            <input
              ref={scanRef}
              placeholder="Scan a barcode or type to search…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => void onScanKey(e)}
              id="scan"
            />
          </div>

          <Results anchor={scanBox} open={term !== ''}>
            <table>
                <tbody {...resultPick.listProps}>
                  {results.map((p, i) => (
                    <tr key={p.id} {...resultPick.rowProps(i)}>
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
          </Results>
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
                    <div>
                      {line.product.name}
                      {line.product.discountBlocked && (
                        <span className="badge" style={{ marginLeft: 7 }} title="Sold on too thin a margin to discount">
                          no discount
                        </span>
                      )}
                    </div>
                    <div className="src">{Pricing.describeSource(line.source)}</div>
                    {/* Said where the mistake is being made, not at the end. A
                        cashier who learns at the payment screen has a queue
                        waiting while they work out which line to change. */}
                    {stockPolicy !== 'allow' && short.has(line.product.id) && (
                      <div className="src warn-note">
                        Only {Quantity.formatQty(line.product.qtyOnHand)} {line.product.baseUnit} in stock
                      </div>
                    )}
                  </td>
                  <td>
                    <select
                      className="select unit-select"
                      value={line.saleUnit}
                      onChange={(e) => editLine(line.key, (l) => ({ ...l, saleUnit: e.target.value }))}
                    >
                      {line.units.map((u) => <option key={u.saleUnit} value={u.saleUnit}>{u.saleUnit}</option>)}
                    </select>
                  </td>
                  <td className="r">
                    {/* `step="any"` rather than a step against a fractional
                        `min`: a number input counts from its minimum, so min
                        0.0001 step 1 made the arrows produce 1.0001, 2.0001,
                        3.0001. Fractional quantities are still typed freely — a
                        shop sells 0.3 kg — the arrows just stop inventing them. */}
                    <input
                      className="qty-input num"
                      type="number" min="0" step="any"
                      value={line.qty}
                      onChange={(e) => editLine(line.key, (l) => ({ ...l, qty: Math.max(0, Number(e.target.value) || 0) }))}
                    />
                  </td>
                  <td className="r">
                    {canOverridePrice ? (
                      <input
                        key={`${line.key}-${line.rate}`}
                        className="qty-input num"
                        defaultValue={Money.format(line.rate as never)}
                        onBlur={(e) => setRate(line.key, e.target.value)}
                      />
                    ) : (
                      <span className="num" title="Changing a price needs permission">
                        {Money.format(line.rate as never)}
                      </span>
                    )}
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
              onClick={() => {
                setCustomerTerm('')
                void searchCustomers(db).then(setCustomers)
                setPickingCustomer(true)
              }}>
              <span>{active.customer?.name ?? 'Walk-in'}</span>
              <span style={{ color: 'var(--ink-3)' }}>Change</span>
            </button>
          </Field>
          {active.customer && active.customer.outstanding > 0 && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--warn)' }}>
              Outstanding <Rupees value={active.customer.outstanding} />
            </div>
          )}
          {/* Which order this tab is settling, said plainly and permanently:
              the notice that announced it is gone by the time the customer
              finishes at the shelf, and a counter restarted after a power cut
              would otherwise have nothing to go on. */}
          {active.fromOrder && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-2)' }}>
              Billing order <strong>{active.fromOrder.docNo}</strong> — marked off when this is paid.
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
          {blocked.length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--ink-3)', margin: '-4px 0 8px' }}>
              {blocked.length === 1
                ? `${blocked[0]!.product.name} takes no discount.`
                : `${blocked.length} items take no discount.`}
              {' '}Only <Rupees value={totals.discountableSubtotal} /> of this bill can be reduced.
            </div>
          )}
          <div className="total-line" style={{ color: 'var(--ink-3)' }}>
            <span>Tax included</span><Rupees value={totals.taxTotal} />
          </div>
          <div className="total-line grand">
            <span>Total</span><Rupees value={totals.grandTotal} className="amount" />
          </div>
        </div>

        <button className="pay-btn" disabled={empty || unfinished} onClick={() => setPaying(true)}>
          <span className="k">F12</span>
          <span>{unfinished ? 'A line has no quantity' : 'Take payment'}</span>
        </button>
      </div>

      {pickingCustomer && (
        <Modal title="Choose a customer" onClose={() => setPickingCustomer(false)}>
          <input
            className="input" placeholder="Name, phone or customer code"
            value={customerTerm}
            onChange={(e) => {
              setCustomerTerm(e.target.value)
              void searchCustomers(db, e.target.value).then(setCustomers)
            }}
            onKeyDown={customerPick.searchKeyDown}
          />
          <table>
            <tbody {...customerPick.listProps}>
              <tr {...customerPick.rowProps(0)}>
                <td><span className="cart-name">Walk-in</span></td><td className="r">—</td>
              </tr>
              {customers.map((c, i) => (
                <tr key={c.id} {...customerPick.rowProps(i + 1)}>
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

          {/* Above the money, not below it. This is the last point at which
              changing the quantity costs nothing, and the buttons stay out of
              reach until it has been answered one way or the other. Under
              `block` the service refuses instead and this never shows. */}
          {sellingShort && (
            <div className="short-gate">
              <div className="short-gate-text">
                <div className="short-gate-head">
                  Not enough stock for {short.size === 1 ? 'this item' : `${short.size} items`}
                </div>
                {[...short.values()].map((w) => (
                  <div key={w.name} className="short-gate-line">
                    {w.name} — <span className="num">{w.have}</span> {w.unit} in stock,
                    selling <span className="num">{w.want}</span>
                  </div>
                ))}
                <div className="short-gate-note">
                  {acknowledged === shortKey
                    ? 'The count will go below zero and the item will be on “Counts that need fixing”.'
                    : 'Change the quantity on the bill, or sell it anyway and fix the count later.'}
                </div>
              </div>
              {acknowledged !== shortKey && (
                <button className="btn warn" onClick={() => setAcknowledged(shortKey)}>
                  Sell anyway
                </button>
              )}
            </div>
          )}

          {due === 0 ? (
            <button className="btn primary lg" disabled={blockedOnShort} onClick={() => void pay('cash')}>
              Settle with points
            </button>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <button className="btn primary lg" disabled={blockedOnShort} onClick={() => void pay('cash')}>Cash</button>
              <button className="btn lg" disabled={blockedOnShort} onClick={() => void pay('upi')}>UPI</button>
              <button className="btn lg" disabled={blockedOnShort} onClick={() => void pay('card')}>Card</button>
              <button
                className="btn lg"
                disabled={blockedOnShort || !active.customer}
                onClick={() => void pay('credit')}
              >
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

/** What is short, in the order a person would say it. */
function describeShort(short: Map<string, { name: string; unit: string; want: number; have: number }>): string {
  const parts = [...short.values()].map(
    (w) => `${w.name} — ${w.have} ${w.unit} in stock, selling ${w.want}`,
  )
  return parts.length === 1 ? `${parts[0]}.` : `${parts.join('; ')}.`
}

/** The one mapping from cart lines to what the totals engine wants. */
function totalsLinesOf(lines: CartLine[]): Totals.TotalsLine[] {
  return lines.map((l) => ({
    qty: Quantity.fromUnits(l.qty),
    rate: l.rate as never,
    taxRateBp: l.product.taxRateBp,
    discountBlocked: l.product.discountBlocked,
  }))
}

function submitMessage(result: Extract<Awaited<ReturnType<typeof submitBill>>, { ok: false }>): string {
  switch (result.code) {
    case 'INSUFFICIENT_STOCK': {
      const first = result.shortfalls[0]
      // This shop has chosen to refuse. Said with the way out, because a cashier
      // who cannot sell the item in the customer's hand needs to know it is a
      // setting and not a fault.
      const how = ' This shop refuses sales below the count — an owner can change that in Settings.'
      return first
        ? `Not enough stock: ${first.productName} has ${Quantity.formatQty(first.available)}, needs ${Quantity.formatQty(first.required)}.${how}`
        : `Not enough stock.${how}`
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
