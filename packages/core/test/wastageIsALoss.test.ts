import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createStockEntry, submitStockEntry, directionOf, signedQty,
} from '../src/services/stockEntry.js'
import { currentStock } from '../src/services/stock.js'
import { rupees } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Wastage takes stock off the shelf.
 *
 * There is no such thing as negative wastage. A shop entering 5 against damaged
 * or expired goods means five gone, and it used to mean five more: the screen
 * held the rule, took the absolute value for a purchase, and passed everything
 * else through exactly as typed. The quantity box starts at 1, so choosing
 * Wastage and pressing save added one to the shelf.
 *
 * The note beside it read "Damaged or expired. Negative." -- which asked a
 * shopkeeper to encode, as a minus sign, a direction they had already chosen
 * from a list two inches above. Adjustment sat next to it saying "May be
 * negative", and the two were indistinguishable in what they did.
 *
 * So the rule is a fact about what wastage *is*, and it lives in the service
 * rather than on the screen. A second way in -- an import, a supplier feed,
 * another screen -- would otherwise each have to remember it, which is how one
 * of them does not.
 */

let fx: Fixture
let product: string

beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
})

afterEach(async () => { await fx.db.close() })

async function post(entryType: 'purchase' | 'adjustment' | 'opening' | 'wastage', units: number) {
  const e = await createStockEntry(fx.db, {
    entryType,
    lines: [{ productId: product, qty: fromUnits(units), unitCost: rupees(50) }],
    actorId: fx.adminId,
  })
  if (!e.ok) throw new Error(e.code)
  const done = await submitStockEntry(fx.db, { entryId: e.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
}

async function onHand(): Promise<number> {
  return toUnits(await currentStock(fx.db, product))
}

describe('what each kind of entry does to the shelf', () => {
  it('takes wastage off, whichever sign it was given', async () => {
    await post('purchase', 20)

    await post('wastage', 5)
    expect(await onHand(), 'five damaged is five gone').toBe(15)

    await post('wastage', -3)
    expect(await onHand(), 'and a minus sign cannot turn a loss into a delivery').toBe(12)
  })

  it('is the difference between wastage and adjustment, which used to be none', async () => {
    /* The two sat next to each other on the list doing exactly the same thing.
       An adjustment is a correction and genuinely goes either way; wastage does
       not. */
    await post('purchase', 20)
    await post('adjustment', 5)
    expect(await onHand(), 'an adjustment of +5 is still +5').toBe(25)

    await post('wastage', 5)
    expect(await onHand(), 'wastage of 5 is not').toBe(20)
  })

  it('refuses a negative purchase rather than quietly flipping it', async () => {
    /* Not the same treatment, and deliberately. Somebody entering -10 against a
       delivery has made a mistake worth stopping on; somebody entering 5
       against wastage has not made one at all. */
    const e = await createStockEntry(fx.db, {
      entryType: 'purchase',
      lines: [{ productId: product, qty: fromUnits(-10), unitCost: rupees(50) }],
      actorId: fx.adminId,
    })
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.code).toBe('INFLOW_NEEDS_POSITIVE_QTY')
  })

  it('leaves an adjustment signed, because a correction has two directions', async () => {
    await post('purchase', 20)
    await post('adjustment', -8)
    expect(await onHand()).toBe(12)
  })
})

describe('the rule on its own', () => {
  it('says which way each kind of entry moves', () => {
    expect(directionOf('purchase')).toBe('in')
    expect(directionOf('opening')).toBe('in')
    expect(directionOf('wastage')).toBe('out')
    expect(directionOf('adjustment')).toBe('either')
  })

  it('is what the screen asks so that the screen and the service cannot disagree', () => {
    /* Exported for the line that shows what the shelf will say afterwards. A
       screen computing the direction a second time is a screen that can be
       right about the preview and wrong about the save. */
    expect(signedQty('wastage', fromUnits(5))).toBe(fromUnits(-5))
    expect(signedQty('purchase', fromUnits(-5))).toBe(fromUnits(5))
    expect(signedQty('adjustment', fromUnits(-5))).toBe(fromUnits(-5))
  })
})
