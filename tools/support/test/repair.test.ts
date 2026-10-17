import { describe, it, expect } from 'vitest'
import { verifyPack, verifyBoard } from '@shopos/core'
import { makeRepairKey, makePack, parseRepairSpec, publicEntry, makeBoard, parseOffSpec } from '../src/repair.js'

/**
 * A pack signed on the vendor's machine, read by the code the till runs:
 * the two sides of one format, held to each other.
 */

describe('a repair pack made by the vendor', () => {
  const key = makeRepairKey('shopos-repair-test')
  const keys = [publicEntry(key)]

  it('is taken by the till as the vendor\'s, for that shop only', async () => {
    const { raw } = makePack(key, { shopId: 'shop-a', ticket: '142', repairs: [{ kind: 'reconcile', what: 'all' }] })
    expect((await verifyPack(raw, keys, { shopId: 'shop-a', now: new Date() })).ok).toBe(true)
    expect(await verifyPack(raw, keys, { shopId: 'shop-b', now: new Date() })).toMatchObject({ code: 'WRONG_SHOP' })
    expect(await verifyPack(raw, [publicEntry(makeRepairKey('shopos-repair-test'))], { shopId: 'shop-a', now: new Date() }))
      .toMatchObject({ code: 'BAD_SIGNATURE' })
  })

  it('reads repairs from the command line, numbers as numbers', () => {
    expect(parseRepairSpec('free_counter:registerId=01a0-x')).toEqual({ kind: 'free_counter', registerId: '01a0-x' })
    expect(parseRepairSpec('renumber_from:docType=bill,prefix=FC,fiscalYear=2627,next=43'))
      .toEqual({ kind: 'renumber_from', docType: 'bill', prefix: 'FC', fiscalYear: '2627', next: 43 })
    expect(parseRepairSpec('retry_set_aside')).toEqual({ kind: 'retry_set_aside' })
  })

  it('will not make a pack the tills would refuse', () => {
    expect(() => makePack(key, { shopId: 'shop-a', ticket: '1', repairs: [parseRepairSpec('drop_table:name=bills')] }))
      .toThrow(/would be refused/)
  })

  it('ends on its date', async () => {
    const now = new Date('2026-10-16T00:00:00Z')
    const { raw } = makePack(key, { shopId: 'shop-a', ticket: '1', repairs: [{ kind: 'retry_set_aside' }], days: 2, now })
    expect(await verifyPack(raw, keys, { shopId: 'shop-a', now: new Date('2026-10-19T00:00:00Z') })).toMatchObject({ code: 'EXPIRED' })
  })
})

describe('a switch board made by the vendor', () => {
  const key = makeRepairKey('shopos-repair-test')

  it('is taken by the till, switching off just what it names', async () => {
    const raw = await makeBoard(key, [parseOffSpec('stock_check:shops=0192f4a1,until=2026-12-01', 'large catalogue')])
    const read = await verifyBoard(raw, [publicEntry(key)])
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.board.off).toEqual([{ feature: 'stock_check', shops: ['0192f4a1'], until: '2026-12-01T00:00:00.000Z', why: 'large catalogue' }])
  })

  it('will not be made to switch off billing', async () => {
    await expect(makeBoard(key, [parseOffSpec('billing', 'no')])).rejects.toThrow(/would be refused/)
  })
})
