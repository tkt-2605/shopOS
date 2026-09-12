import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  listRegisters, createRegister, renameRegister, setRegisterActive,
  getDeviceRegister, setDeviceRegister,
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
  it('falls back to the first active register', async () => {
    expect(await getDeviceRegister(fx.db)).toBe(fx.seed.registerId)
  })

  it('remembers the chosen one', async () => {
    const made = await createRegister(fx.db, { name: 'Front', prefix: 'FC', actorId: fx.adminId })
    if (!made.ok) return
    await setDeviceRegister(fx.db, made.registerId)
    expect(await getDeviceRegister(fx.db)).toBe(made.registerId)
  })

  it('falls back when the chosen one is switched off', async () => {
    const made = await createRegister(fx.db, { name: 'Front', prefix: 'FC', actorId: fx.adminId })
    if (!made.ok) return
    await setDeviceRegister(fx.db, made.registerId)
    await setRegisterActive(fx.db, { registerId: made.registerId, isActive: false, actorId: fx.adminId })
    expect(await getDeviceRegister(fx.db)).toBe(fx.seed.registerId)
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
