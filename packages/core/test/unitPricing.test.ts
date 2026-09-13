import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setUnits, setLadder, setCustomerLadder, setItemPrice } from '../src/services/pricing.js'
import { rowsToRungs, type LadderRow } from '../src/domain/ladder.js'
import { loadPriceCandidates, resolveLinePrice, pricingContextFor } from '../src/repos/pricing.js'
import { resolvePrice } from '../src/domain/pricing.js'
import { createBill } from '../src/services/billing.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { setFeature } from '../src/services/features.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

function rungs(text: string) {
  const rows: LadderRow[] = text.split(',').map((part) => {
    const [minQty, rate] = part.split('=')
    return { minQty: (minQty ?? '').trim(), rate: (rate ?? '').trim() }
  })
  const parsed = rowsToRungs(rows)
  if (!parsed.ok) throw new Error(parsed.code)
  return parsed.rungs
}

/** A pen at ₹10 a piece, also sold by the box of twelve. */
async function aPen(ladder?: string) {
  const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(10) })
  await setUnits(fx.db, ctx(), p, [{ saleUnit: 'box', baseUnits: fromUnits(12) }])
  if (ladder) {
    // A shop with a ladder is a shop that has turned quantity breaks on — the
    // editor offers one price box until it has.
    await setFeature(fx.db, ctx(), 'tieredPricing', true)
    const saved = await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs(ladder),
    })
    if (!saved.ok) throw new Error(saved.code)
  }
  return p
}

async function priceOf(productId: string, saleUnit: string, units: number, customerId?: string) {
  const candidates = await loadPriceCandidates(fx.db, {
    productId, saleUnit,
    customerId: customerId ?? null,
    customerPriceListId: null,
    defaultPriceListId: fx.seed.priceListId,
  })
  return resolvePrice(candidates, fromUnits(units))
}

describe('a bigger unit with no price of its own', () => {
  /* Twelve pens leave the shop; a piece's worth of money must not be what comes
     back. */
  it('costs the base rate times what it holds', async () => {
    const p = await aPen()
    expect((await priceOf(p, 'piece', 1)).rate).toBe(rupees(10))
    expect((await priceOf(p, 'box', 1)).rate).toBe(rupees(120))
  })

  it('bills that way too, not only in the pricing call', async () => {
    const p = await aPen()
    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(1), saleUnit: 'box' }],
      actorId: fx.adminId,
    })
    if (!bill.ok) throw new Error(bill.code)

    const line = await fx.db.get<{ rate: number; base_qty: number; line_total: number }>(
      `SELECT rate, base_qty, line_total FROM bill_items WHERE bill_id = ?`, [bill.billId],
    )
    expect(line?.rate).toBe(rupees(120))
    expect(line?.base_qty).toBe(fromUnits(12))
    expect(line?.line_total).toBe(rupees(120))
  })
})

describe('a ladder written in base units', () => {
  /* The ladder is written once, against the piece, and applies however the goods
     leave the shop. */
  it('applies to the piece as written', async () => {
    const p = await aPen('1=10, 10=9, 50=8')
    expect((await priceOf(p, 'piece', 1)).rate).toBe(rupees(10))
    expect((await priceOf(p, 'piece', 10)).rate).toBe(rupees(9))
    expect((await priceOf(p, 'piece', 50)).rate).toBe(rupees(8))
  })

  it('reaches a rung by the quantity in base units, not in boxes', async () => {
    const p = await aPen('1=10, 10=9, 50=8')

    // One box is twelve pieces, which is past the ten rung: ₹9 a piece.
    expect((await priceOf(p, 'box', 1)).rate).toBe(rupees(108))
    // Five boxes is sixty pieces, past the fifty rung: ₹8 a piece.
    expect((await priceOf(p, 'box', 5)).rate).toBe(rupees(96))
  })

  it('crosses a rung part way up a box', async () => {
    const p = await aPen('1=10, 24=9')
    // One box is twelve pieces — not yet twenty-four.
    expect((await priceOf(p, 'box', 1)).rate).toBe(rupees(120))
    // Two boxes is twenty-four exactly, and the rung is inclusive.
    expect((await priceOf(p, 'box', 2)).rate).toBe(rupees(108))
  })

  it('says the ladder is what decided the price', async () => {
    const p = await aPen('1=10, 10=9')
    expect((await priceOf(p, 'box', 1)).source).toBe('default_list')
  })
})

describe('a price written against the bigger unit itself', () => {
  /* "A box is ₹110" is a deliberate statement about boxes and is not a multiple
     of anything. */
  it('is used when the ladder has nothing better to say', async () => {
    const p = await aPen('1=10')
    await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'box', rate: rupees(110),
    })
    expect((await priceOf(p, 'box', 1)).rate).toBe(rupees(110))
    // And the piece is untouched by it.
    expect((await priceOf(p, 'piece', 1)).rate).toBe(rupees(10))
  })

  /* Letting the two mix meant comparing a threshold of one piece against a
     threshold of one box, which is not a comparison at all — and the ladder's
     bottom rung, the ordinary per-piece price, would outrank a box price the
     shop had deliberately written. */
  it('wins outright, and the piece ladder steps aside', async () => {
    const p = await aPen('1=10, 24=8')
    await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'box', rate: rupees(110),
    })
    expect((await priceOf(p, 'box', 1)).rate).toBe(rupees(110))
    expect((await priceOf(p, 'box', 2)).rate).toBe(rupees(110))
    // The piece keeps its own ladder throughout.
    expect((await priceOf(p, 'piece', 24)).rate).toBe(rupees(8))
  })

  it('takes a ladder of its own when the shop wants volume breaks on boxes', async () => {
    const p = await aPen('1=10, 24=8')
    const saved = await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'box', rungs: rungs('1=110, 2=96'),
    })
    if (!saved.ok) throw new Error(saved.code)

    expect((await priceOf(p, 'box', 1)).rate).toBe(rupees(110))
    expect((await priceOf(p, 'box', 2)).rate).toBe(rupees(96))
  })
})

describe('a customer ladder across units', () => {
  it('follows the same rule', async () => {
    const p = await aPen('1=10, 10=9')
    const customer = await makeCustomer(fx.db, 'Ramesh Stores')
    await setCustomerLadder(fx.db, ctx(), {
      customerId: customer, productId: p, saleUnit: 'piece', rungs: rungs('1=9, 10=8'),
    })

    expect((await priceOf(p, 'piece', 1, customer)).rate).toBe(rupees(9))
    // A box is twelve pieces at their ten-or-more rate.
    const box = await priceOf(p, 'box', 1, customer)
    expect(box.rate).toBe(rupees(96))
    expect(box.source).toBe('customer_override')
  })
})

describe('the whole way through a bill', () => {
  it('prices two boxes off the piece ladder', async () => {
    const p = await aPen('1=10, 10=9, 50=8')
    const pricing = await pricingContextFor(fx.db, null)
    const resolved = await resolveLinePrice(fx.db, pricing, {
      productId: p, saleUnit: 'box', qty: fromUnits(2),
    })
    expect(resolved.rate).toBe(rupees(108))

    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(2), saleUnit: 'box' }],
      actorId: fx.adminId,
    })
    if (!bill.ok) throw new Error(bill.code)

    const line = await fx.db.get<{ rate: number; line_total: number; base_qty: number }>(
      `SELECT rate, line_total, base_qty FROM bill_items WHERE bill_id = ?`, [bill.billId],
    )
    expect(line?.rate).toBe(rupees(108))
    expect(line?.line_total).toBe(rupees(216))
    expect(line?.base_qty).toBe(fromUnits(24))
  })
})
