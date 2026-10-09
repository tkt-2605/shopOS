import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  listRegisters, createRegister, renameRegister, setRegisterActive,
  resolveDeviceRegister, legacyDeviceRegister, forgetLegacyDeviceRegister,
  countersOtherTillsUse, claimRegister, claimIfUnclaimed,
} from '../src/services/registers.js'
import { setDeviceId } from '../src/device.js'
import { getOrOpenSession } from '../src/services/cash.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { postMovement } from '../src/services/stock.js'
import { fromUnits } from '../src/quantity.js'
import { rupees } from '../src/money.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

describe('registers', () => {
  it('starts with the one the bootstrap made', async () => {
    const all = await listRegisters(fx.db)
    expect(all).toHaveLength(1)
    expect(all[0]?.prefix).toBe('MR')
  })

  it('adds a second counter', async () => {
    const r = await createRegister(fx.db, { name: 'Front Counter', prefix: 'FC', actorId: fx.adminId })
    expect(r.ok).toBe(true)
    expect(await listRegisters(fx.db)).toHaveLength(2)
  })

  it('refuses a duplicate prefix — two tills sharing one would collide bill numbers', async () => {
    const r = await createRegister(fx.db, { name: 'Second', prefix: 'MR', actorId: fx.adminId })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PREFIX_TAKEN')
  })

  it('refuses a duplicate name', async () => {
    const r = await createRegister(fx.db, { name: 'Main Register', prefix: 'XX', actorId: fx.adminId })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NAME_TAKEN')
  })

  it('refuses a prefix that is not 2-6 uppercase characters', async () => {
    for (const prefix of ['a', 'TOOLONGPREFIX', 'A-B', '']) {
      const r = await createRegister(fx.db, { name: `T${prefix}`, prefix, actorId: fx.adminId })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('BAD_PREFIX')
    }
  })

  it('uppercases the prefix it is given', async () => {
    await createRegister(fx.db, { name: 'Side', prefix: 'sc', actorId: fx.adminId })
    const all = await listRegisters(fx.db)
    expect(all.map((r) => r.prefix)).toContain('SC')
  })

  it('renames without touching the prefix', async () => {
    const made = await createRegister(fx.db, { name: 'Old', prefix: 'OC', actorId: fx.adminId })
    if (!made.ok) return
    await renameRegister(fx.db, { registerId: made.registerId, name: 'New', actorId: fx.adminId })
    const all = await listRegisters(fx.db)
    const found = all.find((r) => r.id === made.registerId)
    expect(found?.name).toBe('New')
    expect(found?.prefix).toBe('OC')
  })

  it('will not deactivate a counter with the drawer still open', async () => {
    await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId })
    const r = await setRegisterActive(fx.db, { registerId: fx.seed.registerId, isActive: false, actorId: fx.adminId })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('HAS_OPEN_SESSION')
  })

  it('hides a deactivated counter from the list', async () => {
    const made = await createRegister(fx.db, { name: 'Spare', prefix: 'SP', actorId: fx.adminId })
    if (!made.ok) return
    await setRegisterActive(fx.db, { registerId: made.registerId, isActive: false, actorId: fx.adminId })
    expect((await listRegisters(fx.db)).map((r) => r.prefix)).not.toContain('SP')
    expect((await listRegisters(fx.db, true)).map((r) => r.prefix)).toContain('SP')
  })
})

describe('which counter this machine is', () => {
  /* The choice itself lives in device.json now, not in this database — it is a
     fact about the machine, and `settings` is shared by the whole shop. What is
     still a question for the database is whether the chosen counter is real. */

  it('falls back to the first active register when the machine has chosen none', async () => {
    expect(await resolveDeviceRegister(fx.db, null)).toBe(fx.seed.registerId)
  })

  it('uses the one the machine chose', async () => {
    const made = await createRegister(fx.db, { name: 'Front', prefix: 'FC', actorId: fx.adminId })
    if (!made.ok) return
    expect(await resolveDeviceRegister(fx.db, made.registerId)).toBe(made.registerId)
  })

  it('falls back when the chosen one is switched off', async () => {
    const made = await createRegister(fx.db, { name: 'Front', prefix: 'FC', actorId: fx.adminId })
    if (!made.ok) return
    await setRegisterActive(fx.db, { registerId: made.registerId, isActive: false, actorId: fx.adminId })
    expect(await resolveDeviceRegister(fx.db, made.registerId)).toBe(fx.seed.registerId)
  })

  it('falls back when the chosen one was deleted on another till', async () => {
    expect(await resolveDeviceRegister(fx.db, 'a-counter-that-is-not-there')).toBe(fx.seed.registerId)
  })

  /* All four above are a shop with one till, which cannot collide with anybody.
     Once there is a second, the shop's first counter is the one that till bills
     on, and a guess is how two machines mint the same invoice numbers. The sync
     refusal that used to catch it arrives after both have billed, which is too
     late to be a guard. */

  async function anotherTillIsKnown() {
    await fx.db.execute(
      `INSERT INTO sync_peers (device_id, label, created_at) VALUES (?, ?, ?)`,
      ['the-other-till', 'COUNTER2', new Date().toISOString()],
    )
  }

  it('refuses to guess once the shop knows another till', async () => {
    await anotherTillIsKnown()
    expect(await resolveDeviceRegister(fx.db, null)).toBeNull()
  })

  it('still uses the counter this machine chose, peer or no peer', async () => {
    const made = await createRegister(fx.db, { name: 'Front', prefix: 'FC', actorId: fx.adminId })
    if (!made.ok) return
    await anotherTillIsKnown()
    expect(await resolveDeviceRegister(fx.db, made.registerId)).toBe(made.registerId)
  })

  it('refuses to guess rather than falling back when the chosen counter is gone', async () => {
    // The dangerous version of "falls back when the chosen one was deleted":
    // with a second till in the shop, that fallback is the other till's counter.
    await anotherTillIsKnown()
    expect(await resolveDeviceRegister(fx.db, 'a-counter-that-is-not-there')).toBeNull()
  })
})

describe('a counter saying which till sits at it', () => {
  /* Not guessing is half of it. The other half is that both screens offering a
     counter used to offer every one of them, including the one the till next
     door bills on. The claim lives on the counter because that is the only
     place wide enough: a till behind a hub never speaks to its sibling, and two
     tills choosing in the same minute have not spoken to each other yet. */

  const ME = '1111aaaa-1111-4111-8111-111111111111'
  const OTHER = '2222bbbb-2222-4222-8222-222222222222'

  it('is empty in a shop where nobody has claimed anything', async () => {
    expect(await countersOtherTillsUse(fx.db, ME)).toEqual([])
  })

  it('leaves out the counter this machine claimed', async () => {
    // A till is not competing with itself.
    await claimRegister(fx.db, { registerId: fx.seed.registerId, deviceId: ME })
    expect(await countersOtherTillsUse(fx.db, ME)).toEqual([])
  })

  it('names a counter another till claimed', async () => {
    await claimRegister(fx.db, { registerId: fx.seed.registerId, deviceId: OTHER })
    const taken = await countersOtherTillsUse(fx.db, ME)
    expect(taken).toHaveLength(1)
    expect(taken[0]?.registerId).toBe(fx.seed.registerId)
    expect(taken[0]?.deviceId).toBe(OTHER)
  })

  it('counts a claim from a till this one has never met', async () => {
    /* The point of keeping it on the counter. A shop with a hub has tills that
       never exchange a word, and rows -- including this one -- still reach
       them. The peers table would have said this counter was free. */
    await claimRegister(fx.db, { registerId: fx.seed.registerId, deviceId: 'a-till-we-never-synced-with' })
    expect(await countersOtherTillsUse(fx.db, ME)).toHaveLength(1)
  })

  it('releases the counter a till moves away from', async () => {
    // Otherwise a till that moves desks leaves the old counter looking busy
    // for ever, and the shop runs out of counters it is allowed to use.
    const front = await createRegister(fx.db, { name: 'Front', prefix: 'FC', actorId: fx.adminId })
    if (!front.ok) return

    await claimRegister(fx.db, { registerId: fx.seed.registerId, deviceId: OTHER })
    await claimRegister(fx.db, { registerId: front.registerId, deviceId: OTHER })

    const taken = await countersOtherTillsUse(fx.db, ME)
    expect(taken).toHaveLength(1)
    expect(taken[0]?.registerId).toBe(front.registerId)
  })

  it('takes a counter nobody has spoken for, and only that', async () => {
    /* A till that has been selling on the shop's only counter for a year was
       never asked which one it was on. If it never says, the second till is
       offered that counter as free on the day it arrives. */
    const front = await createRegister(fx.db, { name: 'Front', prefix: 'FC', actorId: fx.adminId })
    if (!front.ok) return
    await claimRegister(fx.db, { registerId: front.registerId, deviceId: OTHER })

    await claimIfUnclaimed(fx.db, fx.seed.registerId, ME)
    await claimIfUnclaimed(fx.db, front.registerId, ME)

    // Took the free one; left the other till's alone.
    expect(await countersOtherTillsUse(fx.db, ME))
      .toEqual([expect.objectContaining({ registerId: front.registerId })])
  })

  it('stops this machine billing on a counter it has lost', async () => {
    /* Two tills claimed one counter while out of touch, the merge settled on
       one of them, and this is the other finding out. Better here than at
       `bills.doc_no`, which is the same news one bill too late. */
    setDeviceId(ME)
    try {
      await claimRegister(fx.db, { registerId: fx.seed.registerId, deviceId: ME })
      expect(await resolveDeviceRegister(fx.db, fx.seed.registerId)).toBe(fx.seed.registerId)

      // The other till's claim arrives in a merge and wins.
      await claimRegister(fx.db, { registerId: fx.seed.registerId, deviceId: OTHER })
      expect(await resolveDeviceRegister(fx.db, fx.seed.registerId)).toBeNull()
    } finally {
      setDeviceId(null)
    }
  })
})

describe('moving the choice off the shared table', () => {
  /* Every shop already running has a `device_register_id` row in `settings`.
     On a single till it holds the right answer, so it is moved rather than
     discarded — and then it is gone, because a second till reading it later
     would pick up the first one's counter and mint its invoice numbers.

     Reading and forgetting are separate on purpose: the value has to reach the
     machine before the shared row goes, and that write can fail. */

  async function shopHadChosen(registerId: string) {
    await fx.db.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ('device_register_id', ?, ?)`,
      [registerId, new Date().toISOString()],
    )
  }

  it('hands back what the shop had', async () => {
    await shopHadChosen(fx.seed.registerId)
    expect(await legacyDeviceRegister(fx.db)).toBe(fx.seed.registerId)
  })

  it('keeps holding it until the machine says it has taken it', async () => {
    await shopHadChosen(fx.seed.registerId)

    // Read without forgetting — which is what a failed device write leaves —
    // and the answer is still there for the next start to try again.
    await legacyDeviceRegister(fx.db)
    expect(await legacyDeviceRegister(fx.db)).toBe(fx.seed.registerId)
  })

  it('leaves the shared table with no trace of it once told to forget', async () => {
    await shopHadChosen(fx.seed.registerId)
    await forgetLegacyDeviceRegister(fx.db)

    expect(await legacyDeviceRegister(fx.db)).toBeNull()
    const row = await fx.db.get<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'device_register_id'`,
    )
    expect(row).toBeUndefined()
  })

  it('says nothing was there on a shop that never had one', async () => {
    expect(await legacyDeviceRegister(fx.db)).toBeNull()
  })
})

describe('two counters billing at once', () => {
  it('keeps separate number series so nothing collides', async () => {
    const second = await createRegister(fx.db, { name: 'Front Counter', prefix: 'FC', actorId: fx.adminId })
    if (!second.ok) return

    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: p, qtyChange: fromUnits(100), voucherType: 'opening',
        voucherId: newId(), postingDate: '2026-01-01',
      })
    })

    const numbers: string[] = []
    for (const registerId of [fx.seed.registerId, second.registerId, fx.seed.registerId, second.registerId]) {
      const draft = await createBill(fx.db, {
        registerId, lines: [{ productId: p, qty: fromUnits(1) }], actorId: fx.adminId,
      })
      if (!draft.ok) continue
      const r = await submitBill(fx.db, {
        billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
      })
      if (r.ok) numbers.push(r.docNo)
    }

    expect(new Set(numbers).size).toBe(4)
    expect(numbers.filter((n) => n.startsWith('BMR/'))).toHaveLength(2)
    expect(numbers.filter((n) => n.startsWith('BFC/'))).toHaveLength(2)
    expect(numbers[0]).toMatch(/^BMR\/\d{4}\/00001$/)
    expect(numbers[1]).toMatch(/^BFC\/\d{4}\/00001$/)
    expect(numbers[2]).toMatch(/^BMR\/\d{4}\/00002$/)
  })

  it('gives each counter its own drawer', async () => {
    const second = await createRegister(fx.db, { name: 'Front Counter', prefix: 'FC', actorId: fx.adminId })
    if (!second.ok) return

    const a = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(1000) })
    const b = await getOrOpenSession(fx.db, { registerId: second.registerId, userId: fx.adminId, openingCash: rupees(500) })
    expect(a.sessionId).not.toBe(b.sessionId)

    const list = await listRegisters(fx.db)
    expect(list.every((r) => r.hasOpenSession)).toBe(true)
  })
})

describe('a till makes its own counter', () => {
  it('computes the same prefix for the same machine and a different one for another', async () => {
    const { prefixFor } = await import('../src/services/registers.js')
    const a = newId(), b = newId()
    expect(prefixFor(a)).toBe(prefixFor(a))
    expect(prefixFor(a)).toMatch(/^[A-Z0-9]{4}$/)
    expect(prefixFor(a)).not.toBe(prefixFor(b))
  })

  it('makes one, claims it, and returns the same one next time', async () => {
    const { ensureOwnRegister, prefixFor } = await import('../src/services/registers.js')
    const me = newId()
    const id = await ensureOwnRegister(fx.db, me)
    expect(id).not.toBeNull()
    expect(await ensureOwnRegister(fx.db, me)).toBe(id)
    const mine = (await listRegisters(fx.db)).find((r) => r.id === id)
    expect(mine?.prefix).toBe(prefixFor(me))
    expect(await listRegisters(fx.db)).toHaveLength(2)
  })

  it('moves to the next stem when the shop already has this one', async () => {
    const { ensureOwnRegister, prefixFor } = await import('../src/services/registers.js')
    const me = newId()
    await createRegister(fx.db, { name: 'Typed', prefix: prefixFor(me), actorId: fx.adminId })
    const id = await ensureOwnRegister(fx.db, me)
    const mine = (await listRegisters(fx.db)).find((r) => r.id === id)
    expect(mine?.prefix).toBe(prefixFor(me, 1))
  })

  it('does nothing for a machine that cannot say who it is', async () => {
    const { ensureOwnRegister } = await import('../src/services/registers.js')
    expect(await ensureOwnRegister(fx.db, null)).toBeNull()
  })
})
