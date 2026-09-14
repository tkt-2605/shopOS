import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  listRegisters, createRegister, renameRegister, setRegisterActive,
  resolveDeviceRegister, legacyDeviceRegister, forgetLegacyDeviceRegister,
} from '../src/services/registers.js'
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
    expect(numbers.filter((n) => n.includes('/MR/'))).toHaveLength(2)
    expect(numbers.filter((n) => n.includes('/FC/'))).toHaveLength(2)
    expect(numbers[0]).toMatch(/\/MR\/.*\/00001$/)
    expect(numbers[1]).toMatch(/\/FC\/.*\/00001$/)
    expect(numbers[2]).toMatch(/\/MR\/.*\/00002$/)
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
