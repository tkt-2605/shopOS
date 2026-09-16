import {
  Money, Quantity, Totals,
  bootstrap, setSetting, newId, fiscalYearTag,
  type SqlDriver, type SqlValue,
} from '@shopos/core'
import { Rand } from './random.js'

/**
 * A shop with a year of trade behind it, made up on purpose.
 *
 * ## Why this exists
 *
 * Four things in Phase 3 cannot be checked on a shop with nine bills in it: a
 * query plan that is fine until the table is large, a total that is the total
 * of the five hundred rows on screen, a stock replay that walks the whole
 * ledger, and a merge that has to finish inside a watchdog's patience. All four
 * are bugs that only exist at size, and the honest way to find them is to have
 * something of that size to look at.
 *
 * ## Why it is generated and not a file
 *
 * A checked-in database is a binary nobody reads, that goes stale the first
 * time a migration lands, and that would have to be rebuilt by hand every time
 * the schema moved. This runs the real migrations against an empty file and
 * fills it, so it is by construction at the current schema version. It is also
 * seeded, so the shop is the same shop on every machine and a failure comes
 * with the number that reproduces it.
 *
 * ## What it is not
 *
 * It is not a real shop and does not pretend to be. The names are a word list,
 * the prices are a random walk, and nobody in it has ever asked for a discount.
 * Numbers taken from it describe *this* data — they are evidence about query
 * plans and row counts, which do not care what the customers are called, and
 * they are not evidence about how a shop trades. The rules it does honour are
 * the ones a test would otherwise silently violate: money is computed by
 * `computeTotals`, not by arithmetic written here a second time; the stock cache
 * is what the ledger replays to; document numbers are the format the app mints
 * and `doc_sequences` is left where the next real bill can carry on from.
 *
 * ## Speed
 *
 * Twenty thousand bills is roughly a hundred and forty thousand rows. Two
 * things make that bearable: rows go in batched many-to-a-statement, and the
 * whole run is wrapped in the `applying` flag so the change-feed triggers stay
 * quiet. The second is not only speed — a generated shop has not just *made*
 * twenty thousand changes that a peer is waiting for, and leaving a feed that
 * says it has would be a lie the next sync test would believe.
 */

export interface ShopShape {
  /** Submitted sales. The default is what the phase asks for. */
  bills: number
  products: number
  customers: number
  /** How many days of trade the bills are spread across, ending at `until`. */
  days: number
  /** The last day of trade. Fixed by default, so the shop is the same shop. */
  until: string
  seed: number
}

const DEFAULTS: ShopShape = {
  bills: 20_000,
  products: 400,
  customers: 600,
  days: 365,
  until: '2026-09-15',
  seed: 20260916,
}

export interface SyntheticShop {
  shape: ShopShape
  registerId: string
  registerPrefix: string
  adminId: string
  productIds: string[]
  customerIds: string[]
  /** Submitted sales only; `cancelled` is on top of this. */
  bills: number
  cancelled: number
  billItems: number
  ledgerRows: number
  payments: number
  /** What the shop is owed: the sum over customers who owe something. */
  outstanding: number
  /** Submitted sales less returns and cancellations, at `grand_total`. */
  sales: number
  from: string
  to: string
}

/** How many placeholders to put in one INSERT. */
const BATCH = 160

const TAX_RATES = [0, 500, 1200, 1800] as const

const THINGS = [
  'Rice', 'Sugar', 'Toor Dal', 'Coconut Oil', 'Tea Powder', 'Coffee', 'Wheat Flour',
  'Salt', 'Chilli Powder', 'Turmeric', 'Mustard', 'Tamarind', 'Jaggery', 'Ghee',
  'Soap', 'Shampoo', 'Toothpaste', 'Detergent', 'Incense', 'Matchbox', 'Candle',
  'Notebook', 'Pen', 'Battery', 'Bulb', 'Rope', 'Bucket', 'Broom', 'Umbrella',
]
const SIZES = ['500g', '1kg', '5kg', '100ml', '250ml', '1L', 'small', 'large', 'pack of 6']

const FIRST = [
  'Anand', 'Bhavani', 'Chitra', 'Dinesh', 'Elango', 'Fathima', 'Ganesh', 'Hema',
  'Ilango', 'Jaya', 'Kumar', 'Lakshmi', 'Murugan', 'Nithya', 'Omprakash', 'Priya',
  'Ramesh', 'Saravanan', 'Thangam', 'Uma', 'Vasanthi', 'Yogesh',
]
const LAST = ['Iyer', 'Pillai', 'Reddy', 'Nair', 'Gowda', 'Shetty', 'Menon', 'Rao', 'Naidu']

export async function buildSyntheticShop(
  db: SqlDriver,
  shape: Partial<ShopShape> = {},
): Promise<SyntheticShop> {
  const s: ShopShape = { ...DEFAULTS, ...shape }
  const rand = new Rand(s.seed)

  const seed = await bootstrap(db, { shopName: 'Sixty Years Stores' })
  const prefix = 'MR'
  const now = `${s.until}T20:00:00.000Z`

  /* A registered shop, in a state.
   *
   * Not decoration. Every bill below charges CGST and SGST, and a shop that
   * collects those without a registration to collect them under is not a shop,
   * it is an offence — the tax scheme derives to `unregistered` with no GSTIN
   * and the till stops adding tax at all. The state code is the other half:
   * `supplyTypeFor(null, anything)` answers `intra_state`, so a shop with no
   * state taxes every sale as a local one including the ones that are not, and
   * since Phase 1c `submitBill` refuses outright rather than guess.
   *
   * The shape test bills against the finished shop, which is what found this
   * missing: a fixture full of tax nobody could legally charge, that the real
   * billing path would not have written a single row of. */
  await setSetting(db, 'shop_gstin', '33ALNPJ1906G1ZC', now)
  await setSetting(db, 'shop_state_code', '33', now)

  const adminId = newId()
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
    [adminId, seed.roleIds['Admin']!, now, now],
  )

  return applyingQuietly(db, async () => {
    const days = businessDays(s.until, s.days)
    const products = makeProducts(rand, s.products)
    const customers = makeCustomers(rand, s.customers)

    await insert(db, 'products',
      ['id', 'code', 'name', 'base_unit', 'hsn_code', 'tax_rate_bp', 'base_rate', 'mrp',
        'is_stock_tracked', 'reorder_level', 'created_at', 'updated_at'],
      products.map((p) => [
        p.id, p.code, p.name, p.unit, p.hsn, p.taxRateBp, p.rate, p.mrp,
        p.tracked ? 1 : 0, p.reorderLevel, now, now,
      ]))

    await insert(db, 'customers',
      ['id', 'code', 'name', 'phone', 'state_code', 'credit_limit', 'created_at', 'updated_at'],
      customers.map((c) => [c.id, c.code, c.name, c.phone, '33', c.creditLimit, now, now]))

    const till = new Till(rand, products, customers, days, adminId, seed.registerId, prefix)
    till.trade(s.bills)
    await till.write(db, now)

    return {
      shape: s,
      registerId: seed.registerId,
      registerPrefix: prefix,
      adminId,
      productIds: products.map((p) => p.id),
      customerIds: customers.map((c) => c.id),
      bills: till.submitted,
      cancelled: till.cancelled,
      billItems: till.items.length,
      ledgerRows: till.ledger.length,
      payments: till.payments.length,
      outstanding: till.outstanding(),
      sales: till.sales,
      from: days[0]!,
      to: days[days.length - 1]!,
    }
  })
}

/* ---------------------------------------------------------------- the shop */

interface Product {
  id: string; code: string; name: string; unit: string; hsn: string
  taxRateBp: number; rate: Money.Money; mrp: number; cost: number
  tracked: boolean; reorderLevel: Quantity.Qty | null
}

interface Customer {
  id: string; code: string; name: string; phone: string; creditLimit: Money.Money
}

/** A product's running position, kept the way `movingAverage` keeps it. */
interface Holding { qty: number; value: number }

/**
 * The thing that does the billing.
 *
 * It builds every row in memory first and writes once. Twenty thousand bills
 * interleaved with twenty thousand round trips would take minutes; the shop
 * fits in a few tens of megabytes and the write is then one pass per table.
 */
class Till {
  readonly bills: SqlValue[][] = []
  readonly items: SqlValue[][] = []
  readonly ledger: SqlValue[][] = []
  readonly payments: SqlValue[][] = []
  readonly allocations: SqlValue[][] = []
  readonly audit: SqlValue[][] = []

  submitted = 0
  cancelled = 0
  sales = 0

  /** Per customer: what was put on the khata, and what has come back against it. */
  readonly #owed = new Map<string, number>()
  readonly #paid = new Map<string, number>()
  /** Credit bills still open, oldest first, per customer. */
  readonly #open = new Map<string, { id: string; left: number }[]>()

  readonly #holding = new Map<string, Holding>()
  readonly #seq = new Map<string, number>()

  constructor(
    private readonly rand: Rand,
    private readonly products: Product[],
    private readonly customers: Customer[],
    private readonly days: string[],
    private readonly userId: string,
    private readonly registerId: string,
    private readonly prefix: string,
  ) {}

  trade(count: number): void {
    this.#openingStock()

    // Spread over the days with a little weekly shape, so a "busiest day"
    // query has something to find and every day is not identical.
    const perDay = count / this.days.length
    let left = count
    for (let d = 0; d < this.days.length; d++) {
      const last = d === this.days.length - 1
      const weekend = d % 7 === 5 || d % 7 === 6
      const target = last ? left : Math.min(left, Math.round(perDay * (weekend ? 1.4 : 0.84)))
      for (let i = 0; i < target; i++) this.#bill(this.days[d]!)
      left -= target
      if (left <= 0) break
    }
  }

  #openingStock(): void {
    const day = this.days[0]!
    for (const p of this.products) {
      if (!p.tracked) continue
      const q = Quantity.fromUnits(this.rand.int(120, 900))
      this.#move(p, day, q, p.cost, 'opening_stock', p.id)
    }
  }

  #bill(day: string): void {
    const id = newId()
    const at = `${day}T${String(this.rand.int(8, 20)).padStart(2, '0')}:${String(this.rand.int(0, 59)).padStart(2, '0')}:00.000Z`

    // Roughly a third of sales are to somebody the shop knows by name. The rest
    // walk in, pay, and leave no trace but the bill.
    const customer = this.rand.chance(0.34) ? this.rand.pick(this.customers) : null

    const lines: { product: Product; qty: Quantity.Qty }[] = []
    for (let i = 0, n = this.rand.int(1, 4); i < n; i++) {
      const product = this.rand.pick(this.products)
      if (lines.some((l) => l.product.id === product.id)) continue
      const qty = Quantity.fromUnits(this.rand.int(1, 6))
      if (product.tracked) this.#restockIfShort(product, day, qty)
      lines.push({ product, qty })
    }
    if (lines.length === 0) return

    const totals = Totals.computeTotals(
      lines.map((l) => ({ qty: l.qty, rate: l.product.rate, taxRateBp: l.product.taxRateBp })),
      Money.ZERO, 'intra_state', 'nearest',
    )

    /* One in seventy is cancelled, which is about what a counter does. Only
       cash sales: a cancelled bill that already had a payment allocated to it
       is a real and tangled case, and inventing one here would put a knot in
       the fixture that every test reading it would have to know about. */
    const cancelled = customer === null && this.rand.chance(1 / 70)

    let credit = 0
    if (customer && this.rand.chance(0.3)) {
      credit = totals.grandTotal
      this.#owed.set(customer.id, (this.#owed.get(customer.id) ?? 0) + credit)
      const open = this.#open.get(customer.id) ?? []
      open.push({ id, left: credit })
      this.#open.set(customer.id, open)
    }

    this.bills.push([
      id, this.#docNo('bill', day), cancelled ? 2 : 1, this.registerId,
      customer?.id ?? null, customer?.name ?? null, day,
      totals.subtotal, totals.discount, totals.taxableTotal, totals.taxTotal,
      totals.roundOff, totals.grandTotal, totals.grandTotal - credit, credit,
      '33', 'intra_state', 'sale',
      this.userId, cancelled ? this.userId : null, cancelled ? at : null,
      cancelled ? 'Wrong customer' : null,
      at, at,
    ])

    /* What each line took off the shelf cost, so a cancellation can put back
       exactly that. `reverseVoucher` reads the cost off the row it is undoing
       for the same reason: a reversal valued at anything else is a silent
       revaluation of the stock, and the shop's books move because a bill was
       cancelled. */
    const issued: (number | null)[] = []

    totals.lines.forEach((line, i) => {
      const l = lines[i]!
      this.items.push([
        newId(), id, i, l.product.id, l.product.name, l.product.hsn, l.product.unit,
        l.qty, l.qty, l.product.rate, l.product.mrp, line.billDiscountShare,
        line.lineTotal, line.tax.taxableValue, line.tax.rateBp,
        line.tax.cgst, line.tax.sgst, line.tax.igst, 'base_rate', null,
      ])
      issued.push(l.product.tracked ? this.#move(l.product, day, -l.qty, null, 'bill', id) : null)
    })

    this.audit.push([newId(), 'bills', id, 'submit', this.userId, 0, 1, null, at])

    if (cancelled) {
      this.cancelled++
      lines.forEach((l, i) => {
        if (l.product.tracked) this.#move(l.product, day, l.qty, issued[i] ?? null, 'bill_reversal', id)
      })
      this.audit.push([newId(), 'bills', id, 'cancel', this.userId, 1, 2, null, at])
      return
    }

    this.submitted++
    this.sales += totals.grandTotal
    if (customer && credit > 0) this.#maybeSettle(customer, day)
  }

  /**
   * Money coming back against the khata.
   *
   * Paid against the oldest open bill first, which is what `planAllocation`
   * does, so the allocations here are the shape the real thing writes. Some
   * customers pay in full, some pay something, and some pay nothing at all —
   * the last group is the reason the Credit page exists.
   */
  #maybeSettle(customer: Customer, day: string): void {
    if (!this.rand.chance(0.62)) return

    const open = this.#open.get(customer.id) ?? []
    const due = open.reduce((t, b) => t + b.left, 0)
    if (due <= 0) return

    const amount = this.rand.chance(0.7) ? due : Math.round(due * (0.2 + this.rand.next() * 0.6))
    if (amount <= 0) return

    const paymentId = newId()
    const at = `${day}T18:30:00.000Z`
    this.payments.push([
      paymentId, this.#docNo('payment', day), 1, 'customer', customer.id, day,
      this.rand.pick(['cash', 'upi', 'card']), amount, this.userId, at, at,
    ])

    let left = amount
    for (const bill of open) {
      if (left <= 0) break
      const take = Math.min(left, bill.left)
      if (take <= 0) continue
      this.allocations.push([newId(), paymentId, bill.id, take])
      bill.left -= take
      left -= take
    }
    this.#open.set(customer.id, open.filter((b) => b.left > 0))
    this.#paid.set(customer.id, (this.#paid.get(customer.id) ?? 0) + (amount - left))
    this.audit.push([newId(), 'payment_entries', paymentId, 'submit', this.userId, 0, 1, null, at])
  }

  /** What the shop is owed: customers in credit do not pay off customers in debt. */
  outstanding(): number {
    let total = 0
    for (const c of this.customers) {
      const balance = (this.#owed.get(c.id) ?? 0) - (this.#paid.get(c.id) ?? 0)
      if (balance > 0) total += balance
    }
    return total
  }

  /* ------------------------------------------------------------- the stock */

  #restockIfShort(product: Product, day: string, wanted: number): void {
    const held = this.#holding.get(product.id) ?? { qty: 0, value: 0 }
    if (held.qty >= wanted) return

    // Bought in at a price that wanders, so the moving average is a moving
    // average and not the same number every time.
    const cost = Math.max(1, Math.round(product.cost * (0.9 + this.rand.next() * 0.25)))
    this.#move(product, day, Quantity.fromUnits(this.rand.int(60, 260)), cost, 'stock_entry', newId())
  }

  /**
   * One row of the ledger, and the running position it leaves behind.
   *
   * The arithmetic is `movingAverage`'s, for the case this generator can
   * actually produce: stock never goes below zero, because `#restockIfShort`
   * buys before it sells. That is a narrower rule than the real one and it is
   * deliberately written out rather than imported, so that `recomputeStock`
   * replaying the finished ledger is a second opinion and not an echo. The
   * shape test checks the two agree.
   */
  #move(
    product: Product, day: string, change: number,
    unitCost: number | null, voucherType: string, voucherId: string,
  ): number | null {
    const held = this.#holding.get(product.id) ?? { qty: 0, value: 0 }

    let cost = unitCost
    if (change > 0) {
      const rate = unitCost ?? product.cost
      held.qty += change
      held.value += Math.round((change * rate) / Quantity.QTY_SCALE)
    } else {
      // What is leaving is valued at what is on the shelf, which is also what
      // `postMovement` writes into the row.
      cost = held.qty > 0 ? Math.round((held.value * Quantity.QTY_SCALE) / held.qty) : null
      const covered = Math.max(0, Math.min(-change, held.qty))
      if (covered > 0 && held.qty > 0) held.value -= Math.round((held.value / held.qty) * covered)
      held.qty += change
      if (held.qty <= 0) held.value = 0
    }
    this.#holding.set(product.id, held)

    this.ledger.push([
      newId(), product.id, day, change, cost, held.qty,
      voucherType, voucherId, this.userId, `${day}T12:00:00.000Z`,
    ])
    return cost
  }

  /* ------------------------------------------------------------- the paper */

  #docNo(kind: 'bill' | 'payment', day: string): string {
    // Local midday, so the fiscal year is read off the day the bill says it is
    // and not off whatever that instant is in UTC.
    const fy = fiscalYearTag(new Date(`${day}T12:00:00`))
    const scope = `${kind}:${this.prefix}:${fy}`
    const next = (this.#seq.get(scope) ?? 0) + 1
    this.#seq.set(scope, next)
    const mark = kind === 'bill' ? 'B' : 'R'
    return `${mark}${this.prefix}/${fy}/${String(next).padStart(5, '0')}`
  }

  async write(db: SqlDriver, now: string): Promise<void> {
    await insert(db, 'bills',
      ['id', 'doc_no', 'docstatus', 'register_id', 'customer_id', 'customer_name',
        'posting_date', 'subtotal', 'discount', 'taxable_total', 'tax_total', 'round_off',
        'grand_total', 'paid_total', 'credit_total', 'place_of_supply', 'supply_type', 'kind',
        'created_by', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'created_at', 'updated_at'],
      this.bills)

    await insert(db, 'bill_items',
      ['id', 'bill_id', 'idx', 'product_id', 'product_name', 'hsn_code', 'sale_unit',
        'qty', 'base_qty', 'rate', 'mrp', 'discount', 'line_total', 'taxable_value',
        'tax_rate_bp', 'cgst_amount', 'sgst_amount', 'igst_amount', 'price_source', 'price_source_id'],
      this.items)

    await insert(db, 'stock_ledger',
      ['id', 'product_id', 'posting_date', 'qty_change', 'unit_cost', 'balance_qty',
        'voucher_type', 'voucher_id', 'created_by', 'created_at'],
      this.ledger)

    await insert(db, 'payment_entries',
      ['id', 'doc_no', 'docstatus', 'party_type', 'customer_id', 'posting_date',
        'method', 'amount', 'created_by', 'created_at', 'updated_at'],
      this.payments)

    await insert(db, 'payment_allocations', ['id', 'payment_id', 'bill_id', 'amount'], this.allocations)

    await insert(db, 'audit_log',
      ['id', 'entity', 'entity_id', 'action', 'actor_id', 'docstatus_from', 'docstatus_to', 'diff', 'at'],
      this.audit)

    /* The cache, written from the running position rather than from a replay.
       Two ways of arriving at the same number is the point — see `#move`. */
    await insert(db, 'product_stock', ['product_id', 'qty_on_hand', 'stock_value', 'updated_at'],
      [...this.#holding].map(([id, h]) => [id, h.qty, Math.max(0, h.value), now]))

    /* Where the next real bill carries on from. Without this the shop has
       twenty thousand invoices and a counter that starts again at one, and the
       first test to submit against it would collide on `doc_no`. */
    await insert(db, 'doc_sequences', ['scope', 'last_value'],
      [...this.#seq].map(([scope, value]) => [scope, value]))
  }
}

/* --------------------------------------------------------------- the stuff */

function makeProducts(rand: Rand, count: number): Product[] {
  const out: Product[] = []
  for (let i = 0; i < count; i++) {
    const rate = Money.paise(rand.int(10, 900) * 100 + rand.pick([0, 50, 90]))
    out.push({
      id: newId(),
      code: `P${String(i + 1).padStart(4, '0')}`,
      name: `${rand.pick(THINGS)} ${rand.pick(SIZES)} #${i + 1}`,
      unit: rand.pick(['piece', 'kg', 'litre']),
      hsn: String(rand.int(1001, 9999)),
      taxRateBp: rand.pick(TAX_RATES),
      rate,
      mrp: Math.round(rate * 1.1),
      cost: Math.round(rate * (0.6 + rand.next() * 0.2)),
      // A few things the shop sells are not things it keeps: recharges, and
      // the photocopier.
      tracked: rand.chance(0.94),
      reorderLevel: rand.chance(0.3) ? Quantity.fromUnits(rand.int(5, 40)) : null,
    })
  }
  return out
}

function makeCustomers(rand: Rand, count: number): Customer[] {
  const out: Customer[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      id: newId(),
      code: `C${String(i + 1).padStart(4, '0')}`,
      name: `${rand.pick(FIRST)} ${rand.pick(LAST)} ${i + 1}`,
      phone: `9${String(rand.int(100000000, 999999999))}`,
      // Most people on the khata have no formal limit; the ones who buy for a
      // business have one, and it is the reason the credit check exists.
      creditLimit: rand.chance(0.35) ? Money.paise(rand.int(20, 400) * 10000) : Money.ZERO,
    })
  }
  return out
}

/** The last `count` calendar days ending at `until`, oldest first. */
function businessDays(until: string, count: number): string[] {
  const end = new Date(`${until}T12:00:00Z`)
  const days: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000)
    days.push(d.toISOString().slice(0, 10))
  }
  return days
}

/* --------------------------------------------------------------- the write */

/**
 * Rows in, many to a statement.
 *
 * One `INSERT` per row means one `prepare` per row, and a hundred and forty
 * thousand of those is most of the runtime. The batch size is a compromise
 * with SQLITE_MAX_VARIABLE_NUMBER, which is 32,766 on anything current: a
 * twenty-four column table at 160 rows is 3,840 parameters, well inside it,
 * and the win over one-at-a-time is most of what there is to get.
 */
async function insert(db: SqlDriver, table: string, columns: string[], rows: SqlValue[][]): Promise<void> {
  if (rows.length === 0) return
  const tuple = `(${columns.map(() => '?').join(', ')})`
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES `

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    await db.execute(head + chunk.map(() => tuple).join(', '), chunk.flat())
  }
}

/**
 * Runs `fn` with the change-feed triggers held down.
 *
 * Restored in a `finally`, because a database left with `applying = 1` records
 * nothing it does afterwards and the next thing to notice would be a sync that
 * silently sent nothing.
 */
async function applyingQuietly<T>(db: SqlDriver, fn: () => Promise<T>): Promise<T> {
  await db.execute(`UPDATE sync_state SET applying = 1 WHERE id = 1`)
  try {
    return await fn()
  } finally {
    await db.execute(`UPDATE sync_state SET applying = 0 WHERE id = 1`)
  }
}
