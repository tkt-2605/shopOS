import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Money, Quantity, Totals, Loyalty, Permissions, searchProducts, saleUnitsFor, searchCustomers,
  loadLoyaltyProgram, submitBill, pricingContextFor, resolveLinePrice, chargesTax,
  RULE_46F_THRESHOLD, type ProductListItem, type CustomerListItem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { printBill } from '../core/print'
import { SheetPreview } from '../ui/SheetPreview'
import { useBillTabs, MAX_TABS, type Cart, type CartLine } from '../core/useBillTabs'
import { useShortcuts } from '../core/useShortcuts'
import { Empty, Rupees } from '../ui/components'
import { usePickList, Results } from '../ui/PickList'
import { useConfirm } from '../ui/useConfirm'
import { totalsLinesOf, shortOf } from './billing/cart'
import { submitMessage } from './billing/submitMessage'
import { TabStrip } from './billing/TabStrip'
import { CartTable } from './billing/CartTable'
import { TotalsPanel } from './billing/TotalsPanel'
import { CustomerPicker } from './billing/CustomerPicker'
import { PaymentDialog, type Tender } from './billing/PaymentDialog'
import { DoneDialog, type CompletedBill } from './billing/DoneDialog'

export default function Billing() {
  const { db, registerId, stockPolicy, rounding, taxScheme } = useCore()
  const [confirmUi, ask] = useConfirm()
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
  /* A second click on a tender while the first is still in flight would submit
     the same draft twice. The ref is the guard, because state set in one click
     handler is not yet visible to the next; the state is what greys the buttons. */
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<CompletedBill | null>(null)
  const [printMsg, setPrintMsg] = useState<string | null>(null)
  /** The A4 page, while somebody is looking at it. */
  const [sheet, setSheet] = useState<{ html: string; docNo: string } | null>(null)
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

  /* Lines being sold off a shelf that does not have them. See `shortOf`. */
  const short = useMemo(() => shortOf(active.lines), [active.lines])

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

  /* Only where it is actually the rule: Rule 46(f) is about a tax invoice, and
     a shop on the composition scheme or not registered at all is issuing
     something else. `submitBill` draws the same line. */
  const needsRecipient = chargesTax(taxScheme)
    && !active.customer
    && totals.grandTotal >= RULE_46F_THRESHOLD

  const chooseCustomer = useCallback((customer: CustomerListItem | null) => {
    tabs.patch((cart) => ({ ...cart, customer }))
    setPickingCustomer(false)
  }, [tabs])

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
    if (rate === null || rate < 0) return
    editLine(key, (l) => ({ ...l, rate, manual: true, source: 'manual_override', sourceId: null }))
  }

  const pay = useCallback(async (method: Tender) => {
    if (active.lines.length === 0 || submitting.current) return
    submitting.current = true
    setBusy(true)
    const fail = (error: string) => tabs.patch((cart) => ({ ...cart, error }))

    let result: Awaited<ReturnType<typeof submitBill>>
    let billId: string
    try {
      // The bill on screen is already a draft; paying submits that same document,
      // so the number on the receipt belongs to the row that was there all along.
      // Read after the flush, not off this render: a first line paid for inside
      // the autosave delay has a draft only once the flush has made one.
      await tabs.flush()
      const saved = tabs.savedDraft()
      if (saved.billId === null) {
        fail('The bill on screen could not be saved, so it cannot be taken yet. Check the lines and try again.')
        return
      }
      billId = saved.billId

      result = await submitBill(db, {
        billId,
        payments: due > 0 ? [{ method, amount: due }] : [],
        ...(redeemPoints > 0 ? { redeemPoints } : {}),
        actorId: user.id,
      })
    } catch (err) {
      fail(`The bill could not be completed: ${err instanceof Error ? err.message : String(err)}`)
      return
    } finally {
      submitting.current = false
      setBusy(false)
    }

    if (!result.ok) {
      fail(submitMessage(result))
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
      if (!(await ask(`Cancel this bill? ${label} will be discarded.`))) return
    }
    await tabs.close(cart.tabId)
    focusScan()
  }

  return (
    <div className="billing">
      {confirmUi}
      <div className="bill-left">
        <TabStrip tabs={tabs} activeId={active.tabId} onClose={(cart) => void closeTab(cart)} />

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

        <CartTable
          lines={active.lines}
          totals={totals}
          short={short}
          canOverridePrice={canOverridePrice}
          onEdit={editLine}
          onRate={setRate}
          onRemove={(key) => tabs.patch((cart) => ({
            ...cart, lines: cart.lines.filter((l) => l.key !== key),
          }))}
        />
      </div>

      <TotalsPanel
        cart={active}
        totals={totals}
        blocked={blocked}
        needsRecipient={needsRecipient}
        empty={empty}
        unfinished={unfinished}
        onPickCustomer={() => {
          setCustomerTerm('')
          void searchCustomers(db).then(setCustomers)
          setPickingCustomer(true)
        }}
        onDiscount={(discount) => tabs.patch((cart) => ({ ...cart, discount }))}
        onPay={() => setPaying(true)}
      />

      {pickingCustomer && (
        <CustomerPicker
          customers={customers}
          term={customerTerm}
          onTerm={(typed) => {
            setCustomerTerm(typed)
            void searchCustomers(db, typed).then(setCustomers)
          }}
          onChoose={chooseCustomer}
          onClose={() => setPickingCustomer(false)}
        />
      )}

      {paying && (
        <PaymentDialog
          due={due}
          customer={active.customer}
          redeemable={redeemable}
          redeemPoints={redeemPoints}
          setRedeemPoints={setRedeemPoints}
          redeemedValue={redeemedValue}
          sellingShort={sellingShort}
          short={short}
          acknowledged={acknowledged}
          shortKey={shortKey}
          onAcknowledge={() => setAcknowledged(shortKey)}
          blockedOnShort={blockedOnShort}
          busy={busy}
          onPay={(method) => void pay(method)}
          onClose={() => { setPaying(false); setRedeemPoints(0) }}
        />
      )}

      {done && (
        <DoneDialog
          done={done}
          printMsg={printMsg}
          onPrintMsg={setPrintMsg}
          onSheet={setSheet}
          onNewBill={() => { setDone(null); focusScan() }}
          onClose={() => setDone(null)}
        />
      )}

      {sheet && <SheetPreview html={sheet.html} docNo={sheet.docNo} onClose={() => setSheet(null)} />}
    </div>
  )
}

