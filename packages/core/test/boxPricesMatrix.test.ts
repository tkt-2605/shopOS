import { describe, it, expect, afterAll } from 'vitest'
import {
  setUnits, setItemPrice, setCustomerPrice, setCustomerPriceList, createPriceList,
} from '../src/services/pricing.js'
import { setFeature } from '../src/services/features.js'
import { resolveLinePrice, pricingContextFor, resolveSaleUnit, lineMrp } from '../src/repos/pricing.js'
import { createBill } from '../src/services/billing.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * Every combination of the two switches and what a shop can have saved
 * against a box, through the counter's pricing and a real bill, against an
 * answer worked out here from the rules as a shopkeeper would state them --
 * not from the code under test.
 *
 * A pen: ₹10, MRP ₹10, a box of ten.
 *
 *   the switches   quantity breaks on/off · box prices and MRP on/off
 *   saved          box price for everyone ₹85 · box break 5+ at ₹80 ·
 *                  piece break 10+ at ₹9 · box MRP ₹90 · a batch printed ₹11
 *   who buys       anyone · a customer on a list pricing the box ₹70 ·
 *                  a customer with their own box price ₹75
 *   how many       1 box · 5 boxes
 *
 * 2 × 2 × 32 × 3 × 2 = 768 prices and 384 bills.
 */

interface Saved { boxPrice: boolean; boxBreak: boolean; pieceBreak: boolean; boxMrp: boolean; batchMrp: boolean }
interface Switches { breaks: boolean; boxes: boolean }
type Buyer = 'anyone' | 'list' | 'own'

const flags = [false, true]
const SAVED: Saved[] = flags.flatMap((boxPrice) => flags.flatMap((boxBreak) => flags.flatMap((pieceBreak) =>
  flags.flatMap((boxMrp) => flags.map((batchMrp) => ({ boxPrice, boxBreak, pieceBreak, boxMrp, batchMrp }))))))
const SWITCHES: Switches[] = flags.flatMap((breaks) => flags.map((boxes) => ({ breaks, boxes })))
const BUYERS: Buyer[] = ['anyone', 'list', 'own']
const BOXES = [1, 5]

/** What one box should cost, said the way the shop's rules say it. */
function expectedRate(s: Saved, sw: Switches, buyer: Buyer, boxes: number): number {
  // A customer's own price, then their list's, whatever the switches: both are on Special Prices, in sight.
  if (buyer === 'own') return 75
  if (buyer === 'list') return 70
  // The box's own prices for everyone count only with box prices on; then the piece breaks stay out of it.
  const own = sw.boxes && (s.boxPrice || s.boxBreak)
  if (own) {
    if (sw.breaks && s.boxBreak && boxes >= 5) return 80
    if (s.boxPrice) return 85
    return 100 // only a five-box break, and fewer than five (or breaks off): the box as its pieces at the selling rate
  }
  // As its pieces: ten pens reach the ten-or-more break, but only while breaks are on.
  if (sw.breaks && s.pieceBreak) return 90
  return 100
}

/** What the box line prints as its MRP. */
function expectedMrp(s: Saved, sw: Switches): number {
  if (sw.boxes && s.boxMrp) return 90
  return (s.batchMrp ? 11 : 10) * 10
}

const opened: Fixture[] = []
afterAll(async () => { for (const fx of opened) await fx.db.close() })

async function shopWith(s: Saved) {
  const fx = await freshDb()
  opened.push(fx)
  const ctx = { actorId: fx.adminId }
  const list = fx.seed.priceListId
  const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(10), taxRateBp: 0 })
  await fx.db.execute('UPDATE products SET mrp = ? WHERE id = ?', [rupees(10), p])
  await setUnits(fx.db, ctx, p, [{ saleUnit: 'box', baseUnits: fromUnits(10) }])

  const price = async (unit: string, from: number, rate: number) => {
    const r = await setItemPrice(fx.db, ctx, { productId: p, priceListId: list, saleUnit: unit, minQty: fromUnits(from), rate: rupees(rate) })
    if (!r.ok) throw new Error(r.code)
  }
  if (s.boxPrice) await price('box', 1, 85)
  if (s.boxBreak) await price('box', 5, 80)
  if (s.pieceBreak) await price('piece', 10, 9)
  // Written straight in: the service would refuse some of these as above the MRP, which is its own test.
  if (s.boxMrp) await fx.db.execute(`UPDATE product_units SET mrp = ? WHERE product_id = ? AND sale_unit = 'box'`, [rupees(90), p])

  let batchId: string | null = null
  if (s.batchMrp) {
    batchId = newId()
    const now = new Date().toISOString()
    await fx.db.execute(
      `INSERT INTO batches (id, product_id, batch_no, mrp, created_at, updated_at) VALUES (?, ?, 'MRP 11', ?, ?, ?)`,
      [batchId, p, rupees(11), now, now],
    )
  }

  const wholesale = await createPriceList(fx.db, ctx, { name: 'Wholesale' })
  if (!wholesale.ok) throw new Error(wholesale.code)
  const onList = await makeCustomer(fx.db, 'School')
  await setCustomerPriceList(fx.db, ctx, onList, wholesale.priceListId)
  const r1 = await setItemPrice(fx.db, ctx, { productId: p, priceListId: wholesale.priceListId, saleUnit: 'box', minQty: fromUnits(1), rate: rupees(70) })
  if (!r1.ok) throw new Error(r1.code)
  const ownPrice = await makeCustomer(fx.db, 'Office')
  const r2 = await setCustomerPrice(fx.db, ctx, { customerId: ownPrice, productId: p, saleUnit: 'box', rate: rupees(75) })
  if (!r2.ok) throw new Error(r2.code)

  const customer: Record<Buyer, string | null> = { anyone: null, list: onList, own: ownPrice }
  return { fx, p, batchId, customer }
}

const label = (s: Saved) => Object.entries(s).filter(([, v]) => v).map(([k]) => k).join('+') || 'nothing saved'

describe('a box, every way it can be set up', () => {
  for (const saved of SAVED) {
    it(label(saved), async () => {
      const { fx, p, batchId, customer } = await shopWith(saved)
      const ctx = { actorId: fx.adminId }
      const wrong: string[] = []

      for (const sw of SWITCHES) {
        await setFeature(fx.db, ctx, 'tieredPricing', sw.breaks)
        await setFeature(fx.db, ctx, 'unitPrices', sw.boxes)
        for (const buyer of BUYERS) {
          const pricing = await pricingContextFor(fx.db, customer[buyer])
          for (const boxes of BOXES) {
            const where = `breaks ${sw.breaks ? 'on' : 'off'}, box prices ${sw.boxes ? 'on' : 'off'}, ${buyer}, ${boxes} box`
            const want = rupees(expectedRate(saved, sw, buyer, boxes))

            // The counter's price.
            const got = await resolveLinePrice(fx.db, pricing, { productId: p, saleUnit: 'box', qty: fromUnits(boxes), batchId })
            if (got.rate !== want) wrong.push(`${where}: counter ${got.rate}, want ${want}`)

            // The bill's, with the rate the counter sent as already resolved -- the bill holds it to the rules.
            const bill = await createBill(fx.db, {
              registerId: fx.seed.registerId, customerId: customer[buyer], actorId: fx.adminId,
              lines: [{ productId: p, qty: fromUnits(boxes), saleUnit: 'box', batchId, resolved: got }],
            })
            if (!bill.ok) { wrong.push(`${where}: bill refused ${bill.code}`); continue }
            const line = (await fx.db.get<{ rate: number; mrp: number | null; base_qty: number }>(
              'SELECT rate, mrp, base_qty FROM bill_items WHERE bill_id = ?', [bill.billId],
            ))!
            if (line.rate !== want) wrong.push(`${where}: bill ${line.rate}, want ${want}`)
            if (line.mrp !== rupees(expectedMrp(saved, sw))) wrong.push(`${where}: MRP ${line.mrp}, want ${rupees(expectedMrp(saved, sw))}`)
            if (line.base_qty !== fromUnits(boxes * 10)) wrong.push(`${where}: ${line.base_qty} pieces out of stock`)

            // The screen's MRP agrees with the bill's.
            const unit = await resolveSaleUnit(fx.db, p, 'box')
            const perBase = (s: Saved) => rupees(s.batchMrp ? 11 : 10) as Money
            if (lineMrp(perBase(saved), unit, sw.boxes) !== line.mrp) wrong.push(`${where}: screen and bill MRP differ`)
          }
        }
      }
      expect(wrong).toEqual([])
    }, 60_000)
  }
})

describe('a switch flipped while a bill is on screen', () => {
  it('refuses the price the screen worked out before, rather than charging a price the shop no longer uses', async () => {
    const { fx, p } = await shopWith({ boxPrice: true, boxBreak: false, pieceBreak: false, boxMrp: false, batchMrp: false })
    const ctx = { actorId: fx.adminId }
    await setFeature(fx.db, ctx, 'unitPrices', true)
    const onScreen = await resolveLinePrice(fx.db, await pricingContextFor(fx.db, null), { productId: p, saleUnit: 'box', qty: fromUnits(1) })
    expect(onScreen.rate).toBe(rupees(85))

    await setFeature(fx.db, ctx, 'unitPrices', false) // on another till, say
    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId, actorId: fx.adminId,
      lines: [{ productId: p, qty: fromUnits(1), saleUnit: 'box', resolved: onScreen }],
    })
    expect(bill).toMatchObject({ ok: false, code: 'RATE_NOT_THE_RULE', rate: rupees(85), rule: rupees(100) })
  })
})
