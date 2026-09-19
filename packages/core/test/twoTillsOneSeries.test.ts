import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { openCount, cancelCount } from '../src/services/stockCount.js'
import { recordPayment, recordOpeningBalance } from '../src/services/payments.js'
import { createRegister } from '../src/services/registers.js'
import { setDeviceId } from '../src/device.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * One series name, one counter per machine.
 *
 * `numbering.ts` opens by saying that a register prefix is not cosmetic --
 * "two terminals billing offline must not both mint INV-0042, and a globally
 * sequential counter cannot survive a second till". Five callers then passed a
 * constant where a register belonged. Stock entries and stock counts
 * hard-coded `'MR'`; the three payment paths and the opening balance took an
 * optional prefix that no screen ever supplied and fell back to `'MR'` too.
 *
 * `doc_sequences` is the one table deliberately kept out of replication,
 * because taking either side of a counter would hand two tills the same
 * invoice number. So a shared series name plus a local counter is the exact
 * thing that table exists to prevent, arrived at from the other direction.
 *
 * It fails in two ways and the quiet one is worse. A till that has *received*
 * the other's document cannot mint at all: its counter is behind, it produces
 * a number the incoming row already holds, `doc_no ... UNIQUE` rejects it, and
 * the rollback means the counter never advances -- so every retry produces the
 * identical number, for ever. And two tills that mint before they meet both
 * succeed locally, and one of the two documents is quarantined on arrival.
 *
 * Found by posting stock in on a real till. The bench had never had two tills
 * make a stock entry -- only bills, which partition correctly.
 */

const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
const TILL_B = '2222bbbb-2222-4222-8222-222222222222'

let fx: Fixture
let product: string
let registerB: string

beforeEach(async () => {
  fx = await freshDb()
  setDeviceId(TILL_A)
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })

  /* Two counters, one claimed by each till, which is what a two-till shop is.
     The seeded register is A's; B gets its own. */
  await fx.db.execute(
    `UPDATE registers SET claimed_by = ? WHERE id = ?`, [TILL_A, fx.seed.registerId],
  )
  const b = await createRegister(fx.db, { name: 'Back counter', prefix: 'BC', actorId: fx.adminId })
  if (!b.ok) throw new Error(b.code)
  registerB = b.registerId
  await fx.db.execute(
    `UPDATE registers SET claimed_by = ? WHERE id = ?`, [TILL_B, b.registerId],
  )
})

afterEach(async () => {
  setDeviceId(null)
  await fx.db.close()
})

async function stockIn(): Promise<string> {
  const e = await createStockEntry(fx.db, {
    entryType: 'purchase',
    lines: [{ productId: product, qty: fromUnits(10), unitCost: rupees(50) }],
    supplierName: 'Acme',
    actorId: fx.adminId,
  })
  if (!e.ok) throw new Error(e.code)
  const done = await submitStockEntry(fx.db, { entryId: e.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
  return done.docNo
}

/**
 * A submitted entry as it arrives from the other till.
 *
 * The row lands and the sequence does not, which is the whole shape of the
 * bug: `doc_sequences` is deliberately outside replication, so a till holds
 * somebody else's document while its own counter has never moved. Writing it
 * straight in is what `applyBatch` does -- going through `submitStockEntry`
 * here would advance this machine's counter and hide the thing being tested.
 */
async function arrives(docNo: string): Promise<void> {
  const nowIso = new Date().toISOString()
  await fx.db.execute(
    `INSERT INTO stock_entries
       (id, doc_no, docstatus, entry_type, posting_date, created_by, created_at, updated_at)
     VALUES (?, ?, 1, 'purchase', '2026-09-17', ?, ?, ?)`,
    [newId(), docNo, fx.adminId, nowIso, nowIso],
  )
}

describe('a stock entry posted on the second till', () => {
  it('does not collide with the one this till was sent', async () => {
    /* The reproduction, in the order it happened in the shop. The other till
       posted `SMR/2627/00001` -- every till minted under `MR` -- and it
       replicated here. This till then tries to post its own. */
    await arrives('SMR/2627/00001')

    setDeviceId(TILL_B)
    expect(
      await stockIn(),
      'the till that was sent the other one must still be able to post stock in',
    ).not.toBe('SMR/2627/00001')
  })

  it('keeps working on the till that is behind, however many times it tries', async () => {
    /* The part that made it unrecoverable rather than merely wrong. The
       rollback never advanced the sequence, so every retry rebuilt the same
       number -- forty of them in forty seconds on the real till, each one
       leaving a draft behind. */
    await arrives('SMR/2627/00001')
    setDeviceId(TILL_B)

    const seen = new Set<string>()
    for (let i = 0; i < 3; i += 1) seen.add(await stockIn())

    expect(seen.size, 'three posts, three numbers').toBe(3)
  })

  it('names the counter it was posted at, as every other document does', async () => {
    setDeviceId(TILL_B)
    expect(await stockIn()).toMatch(/^SBC\//)
  })
})

describe('the other four series that shared one name', () => {
  it('gives two tills different stock count numbers', async () => {
    /* A sheet is closed before the next is opened, because a shop counts
       one set of shelves at a time and `openCount` refuses a second. The
       numbers still have to differ: the sheet A opened has replicated, and
       B is minting against a counter that never saw it. */
    const a = await openCount(fx.db, { scope: { kind: 'all' }, includeEmpty: true, actorId: fx.adminId })
    if (!a.ok) throw new Error(a.code)
    await cancelCount(fx.db, { countId: a.countId, actorId: fx.adminId })

    setDeviceId(TILL_B)
    const b = await openCount(fx.db, { scope: { kind: 'all' }, includeEmpty: true, actorId: fx.adminId })
    if (!b.ok) throw new Error(b.code)

    expect(b.docNo).not.toBe(a.docNo)
  })

  it('gives two tills different payment numbers', async () => {
    /* The quiet half. Both of these succeed locally whatever the numbering, so
       nothing goes wrong until they meet -- and then one of two payments a shop
       has actually taken is quarantined on arrival. */
    const customer = await makeCustomer(fx.db, 'Priya')
    const a = await recordPayment(fx.db, {
      customerId: customer, amount: rupees(100), method: 'cash', actorId: fx.adminId,
    })

    if (!a.ok) throw new Error(a.code)

    setDeviceId(TILL_B)
    const b = await recordPayment(fx.db, {
      customerId: customer, amount: rupees(100), method: 'cash', actorId: fx.adminId,
    })
    if (!b.ok) throw new Error(b.code)

    expect(b.docNo).not.toBe(a.docNo)
  })

  it('gives two tills different opening balances, and still marks them as opening', async () => {
    /* `OB` has to survive the fix. Handing these the till prefix on its own
       would file an opening balance into the same series as real invoices. */
    const one = await makeCustomer(fx.db, 'Old account one')
    const a = await recordOpeningBalance(fx.db, {
      customerId: one, amount: rupees(500),
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })
    if (!a.ok) throw new Error(a.code)

    setDeviceId(TILL_B)
    const two = await makeCustomer(fx.db, 'Old account two')
    const b = await recordOpeningBalance(fx.db, {
      customerId: two, amount: rupees(500),
      registerId: registerB, actorId: fx.adminId,
    })
    if (!b.ok) throw new Error(b.code)

    expect(b.docNo).not.toBe(a.docNo)
    expect(a.docNo, 'still an opening balance, not a sale').toContain('OB')
    expect(b.docNo).toContain('OB')
  })
})

describe('a shop with one till', () => {
  it('is unaffected, because it has nobody to collide with', async () => {
    /* The fallback is what a till with no counter of its own gets, and it is
       safe exactly there: one machine cannot disagree with itself. */
    await fx.db.execute(`UPDATE registers SET claimed_by = NULL`)
    setDeviceId(TILL_A)

    expect(await stockIn()).toMatch(/^SMR\//)
  })
})
