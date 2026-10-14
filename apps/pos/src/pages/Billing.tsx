import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Batches, Money, Quantity, Totals, Loyalty, Permissions, searchProducts, saleUnitsFor,
  loadLoyaltyProgram, monthToDateSpend, businessDate, submitBill, pricingContextFor, resolveLinePrice, chargesTax,
  RULE_46F_THRESHOLD, type ProductListItem, type CustomerListItem,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { printBill } from '../core/print'
import { SheetPreview } from '../ui/SheetPreview'
import { useBillTabs, MAX_TABS, type Cart, type CartLine } from '../core/useBillTabs'
import { pricedForOf, pricingBatch } from '../core/billCarts'
import { useRepricing } from '../core/useRepricing'
import { useShortcuts } from '../core/useShortcuts'
import { Empty, Rupees } from '../ui/components'
import { usePickList, Results } from '../ui/PickList'
import { useSearch, productMatches } from '../ui/useSearch'
import { useConfirm } from '../ui/useConfirm'
import { totalsLinesOf, shortOf, picksOf } from './billing/cart'
import { submitMessage, unsavedMessage } from './billing/submitMessage'
import { restoreHold, restoreHoldMessage } from '../core/restoreHold'
import { TabStrip } from './billing/TabStrip'
import { CartTable } from './billing/CartTable'
import { TotalsPanel } from './billing/TotalsPanel'
import { CustomerPicker } from './billing/CustomerPicker'
import { PaymentDialog, type Tender } from './billing/PaymentDialog'
import { DoneDialog, type CompletedBill } from './billing/DoneDialog'
import { OpenPriceDialog } from './billing/OpenPriceDialog'
import { useScanChoice } from '../ui/ScanChoice'
import { usePriceChoice } from '../ui/PriceChoice'
import { useDrawer } from './billing/useDrawer'
import { useQuote } from './billing/QuoteDialog'

export default function Billing() {
  const { db, registerId, stockPolicy, rounding, taxScheme } = useCore()
  const [confirmUi, ask] = useConfirm()
  const user = useUser()
  const tabs = useBillTabs(db, registerId, user.id)
  const active = tabs.active
  const canOverridePrice = Permissions.can(user.permissions, 'price_list', 'write')

  const [term, setTerm] = useState('')
  const [pickingCustomer, setPickingCustomer] = useState(false)
  /** The loose item, waiting for its amount. See `OpenPriceDialog`. */
  const [askingAmount, setAskingAmount] = useState<ProductListItem | null>(null)
  const [paying, setPaying] = useState(false)
  const drawer = useDrawer(db, registerId, user, paying)
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

  const search = useSearch(term, (t) => searchProducts(db, { term: t, limit: 40 }), { browse: true, matches: productMatches })
  const results = search.rows

  /* The shop's rounding rule, applied here as well as in the service. The
     cashier is looking at this number while the customer hands over the money,
     so it has to be the number the bill will carry — not a near miss the
     receipt then corrects. */
  const totals = useMemo(
    () => Totals.computeTotals(
      totalsLinesOf(active.lines, chargesTax(taxScheme)),
      (Money.parseMoney(active.discount) ?? 0) as never,
      'intra_state',
      rounding,
    ),
    [active.lines, active.discount, rounding, taxScheme],
  )
  const quote = useQuote(active, totals.grandTotal, () => setPickingCustomer(true), () => tabs.close(active.tabId))

  /* Lines the shop sells at a few rupees a unit. The discount box has to say so,
     because a cashier typing ₹50 off a bill that is mostly recharge will
     otherwise see a number that does not happen. */
  const blocked = active.lines.filter((l) => l.product.discountBlocked)

  const empty = active.lines.length === 0
  /* A line left at zero is half-typed, not a sale. Said rather than silently
     billed for nothing. */
  const unfinished = active.lines.some((l) => l.qty <= 0)
  /* A line whose unit, quantity or customer changed and whose rate has not
     caught up yet. Not paid for until it has. */
  const repricing = useRepricing(db, active, tabs.patch)

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

  /* Where the customer stands against the monthly target, fetched when the
     customer changes and again after each bill, so the line the cashier reads
     out is the one the next bill will be judged on. */
  const [monthSpent, setMonthSpent] = useState<Money.Money | null>(null)
  const targetCustomer = program?.enabled && program.monthlyTarget > 0 ? active.customer?.id ?? null : null
  useEffect(() => {
    setMonthSpent(null)
    if (!targetCustomer) return
    let cancelled = false
    void monthToDateSpend(db, targetCustomer, businessDate()).then((spent) => { if (!cancelled) setMonthSpent(spent) })
    return () => { cancelled = true }
  }, [db, targetCustomer, done])

  const loyaltyMonth = program && targetCustomer && monthSpent !== null
    ? {
        spent: monthSpent,
        target: program.monthlyTarget,
        thisBill: Money.add(...totals.lines
          .filter((_, i) => !active.lines[i]?.product.loyaltyBlocked)
          .map((l) => l.lineTotal)),
      }
    : null

  const redeemedValue = program && redeemPoints > 0
    ? Loyalty.pointsToMoney(program, redeemPoints, totals.grandTotal)
    : 0
  const due = (totals.grandTotal - redeemedValue) as typeof totals.grandTotal

  /* Resolved through the same core call the service uses, so the rate on screen
     is the rate that gets saved. */
  const addProduct = useCallback(async (product: ProductListItem, amount?: Money.Money, choice?: Batches.PriceChoice) => {
    // Priced at the counter: nothing goes on the bill until somebody says how much.
    if (product.openPrice && amount === undefined) {
      setTerm('')
      setAskingAmount(product)
      return
    }
    // The same item at two MRPs on the shelf: the cashier reads the pack. One price asks nothing.
    if (amount === undefined && choice === undefined && await priceChoice.asks(product)) { setTerm(''); return }
    const batchPick = choice?.pick ?? null
    const units = await saleUnitsFor(db, product.id)
    const unit = units.find((u) => u.isDefault) ?? units[0]!
    const context = await pricingContextFor(db, active.customer?.id ?? null)
    const resolved = amount !== undefined
      ? { rate: amount, source: 'manual_override' as const, sourceId: null, includesTax: true }
      : await resolveLinePrice(db, context, {
          productId: product.id, saleUnit: unit.saleUnit, qty: Quantity.fromUnits(1), batchId: pricingBatch({ batchPick }),
        })

    tabs.patch((cart) => {
      // A second scan at the same price adds to the line; at another price it is a line of its own.
      const at = cart.lines.findIndex(
        (l) => l.product.id === product.id && l.saleUnit === unit.saleUnit && !l.manual
          && (l.batchPick ?? null) === batchPick,
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
        // A typed amount is manual, so each loose sale is its own line: manual lines are not merged above.
        manual: amount !== undefined,
        includesTax: resolved.includesTax,
        batchPick,
        batchMrp: choice?.mrp ?? null,
        pricedFor: pricedForOf({ saleUnit: unit.saleUnit, qty: 1, batchPick }, active.customer?.id ?? null),
      }
      return { ...cart, lines: [...cart.lines, line], error: null }
    })

    setTerm('')
    focusScan()
  }, [db, active.customer, tabs, focusScan])
  const scanChoice = useScanChoice((p) => void addProduct(p))
  const priceChoice = usePriceChoice(db, (p, choice) => void addProduct(p, undefined, choice), focusScan)

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
    const typed = term.trim()
    // `latest`, not `results`: a scanner beats the search, and `results` would be the empty box's.
    const rows = await search.latest()
    // One code on several items (069): the cashier picks, by the price on the pack.
    if (scanChoice.ask(rows, typed)) return
    const [pick] = rows
    if (pick) return addProduct(pick)
    if (typed) tabs.patch((cart) => ({ ...cart, error: `Nothing in the catalog matches ${typed}.` }))
    setTerm('')
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
   * lets someone set prices in the first place. Except on a loose item, where
   * typing the amount is the sale -- and nothing is not an amount.
   */
  function setRate(key: string, value: string) {
    const open = active.lines.find((l) => l.key === key)?.product.openPrice === true
    if (!canOverridePrice && !open) return
    const rate = Money.parseMoney(value)
    if (rate === null || rate < 0 || (open && rate === 0)) return
    editLine(key, (l) => ({ ...l, rate, manual: true, source: 'manual_override', sourceId: null }))
  }

  const pay = useCallback(async (method: Tender, tendered?: Money.Money) => {
    if (active.lines.length === 0 || submitting.current) return
    if (repricing) return
    submitting.current = true
    setBusy(true)
    const fail = (error: string) => tabs.patch((cart) => ({ ...cart, error }))

    /* Before a number is taken. The banner above says the same and carries
       the way on; see `restoreHold.ts`. */
    const hold = restoreHold()
    if (hold !== null) {
      submitting.current = false
      setBusy(false)
      fail(restoreHoldMessage(hold))
      return
    }

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
        fail(unsavedMessage(saved.reason))
        return
      }
      billId = saved.billId

      result = await submitBill(db, {
        billId,
        payments: due > 0 ? [{ method, amount: due, ...(method === 'cash' && tendered ? { tendered } : {}) }] : [],
        ...(redeemPoints > 0 ? { redeemPoints } : {}),
        batchPicks: picksOf(active.lines),
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

    const change = method === 'cash' && tendered && tendered > due ? { change: tendered - due } : {}
    setDone({ billId, docNo: result.docNo, total: totals.grandTotal, points: result.pointsEarned, ...change })
    setPrintMsg(null)
    // Print straight away; the dialog stays up so a failed print can be retried.
    void printBill(db, billId).then((r) => { if (!r.ok) setPrintMsg(r.message) })
    setPaying(false)
    setRedeemPoints(0)
    tabs.released()
    setTerm('')
    focusScan()
  }, [db, user.id, active.lines, tabs, totals.grandTotal, due, redeemPoints, focusScan, repricing])

  /* The counter should not need the mouse. Only bound keys are advertised.
     Every one of these now stands down while a dialog is open — the payment
     sheet used to be reachable with F12 from inside the customer picker, and
     Ctrl+W would cancel the bill behind whatever was on screen. */
  useShortcuts([
    // Allowed while typing: the cashier is often in the quantity box when the
    // customer is ready to pay.
    { key: 'F12', whileTyping: true, run: () => { if (!empty && !unfinished && !repricing && !done) setPaying(true) } },
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
        loyaltyMonth={loyaltyMonth}
        empty={empty}
        unfinished={unfinished}
        repricing={repricing}
        onPickCustomer={() => setPickingCustomer(true)}
        onDiscount={(discount) => tabs.patch((cart) => ({ ...cart, discount }))}
        onPay={() => setPaying(true)}
        {...(Permissions.can(user.permissions, 'document', 'create') ? { quote } : {})}
      />
      {scanChoice.dialog}
      {priceChoice.dialog}
      {askingAmount !== null && (
        <OpenPriceDialog
          product={askingAmount}
          onAdd={(amount) => { setAskingAmount(null); void addProduct(askingAmount, amount) }}
          onClose={() => { setAskingAmount(null); focusScan() }}
        />
      )}

      {pickingCustomer && (
        <CustomerPicker
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
          onPay={(method, tendered) => void pay(method, tendered)}
          drawerClosed={drawer.closed}
          canOpenDrawer={drawer.canOpen}
          onOpenDrawer={drawer.open}
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
