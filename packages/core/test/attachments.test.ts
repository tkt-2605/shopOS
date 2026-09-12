import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  listAttachments, countAttachments, recordAttachment, removeAttachment,
  attachmentsToCarry, type StoredFile,
} from '../src/services/attachments.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { postMovement } from '../src/services/stock.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

/** What the Rust side hands back once the bytes are on disk. */
function stored(sha: string, overrides: Partial<StoredFile> = {}): StoredFile {
  return {
    fileName: overrides.fileName ?? 'bill-photo.jpg',
    mime: overrides.mime ?? 'image/jpeg',
    sizeBytes: overrides.sizeBytes ?? 240_000,
    sha256: sha,
    storedPath: overrides.storedPath ?? `${sha.slice(0, 2)}/${sha}.jpg`,
  }
}

const ctx = () => ({ actorId: fx.adminId })

describe('attaching a file to a document', () => {
  it('lists what is attached, oldest first', async () => {
    const billId = newId()
    await recordAttachment(fx.db, { ...ctx(), now: () => '2026-09-13T10:00:00.000Z' }, {
      entity: 'bill', entityId: billId, file: stored('a'.repeat(64)),
    })
    await recordAttachment(fx.db, { ...ctx(), now: () => '2026-09-13T10:05:00.000Z' }, {
      entity: 'bill', entityId: billId, file: stored('b'.repeat(64)), caption: '  UPI screenshot  ',
    })

    const found = await listAttachments(fx.db, 'bill', billId)
    expect(found.map((a) => a.sha256)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect(found[1]!.caption).toBe('UPI screenshot')
  })

  it('keeps one document\'s photographs out of another\'s', async () => {
    const mine = newId()
    const theirs = newId()
    await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: mine, file: stored('c'.repeat(64)) })
    await recordAttachment(fx.db, ctx(), { entity: 'stock_entry', entityId: theirs, file: stored('d'.repeat(64)) })

    expect(await listAttachments(fx.db, 'bill', mine)).toHaveLength(1)
    expect(await listAttachments(fx.db, 'bill', theirs)).toHaveLength(0)
  })

  it('counts them per document for a list screen', async () => {
    const one = newId()
    const two = newId()
    await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: one, file: stored('e'.repeat(64)) })
    await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: one, file: stored('f'.repeat(64)) })
    await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: two, file: stored('0'.repeat(64)) })

    const counts = await countAttachments(fx.db, 'bill', [one, two, newId()])
    expect(counts.get(one)).toBe(2)
    expect(counts.get(two)).toBe(1)
    expect(counts.size).toBe(2)
  })

  it('records who attached it and when', async () => {
    const billId = newId()
    const a = await recordAttachment(fx.db, { ...ctx(), now: () => '2026-09-13T09:00:00.000Z' }, {
      entity: 'bill', entityId: billId, file: stored('1'.repeat(64)),
    })
    expect(a.createdBy).toBe(fx.adminId)
    expect(a.createdAt).toBe('2026-09-13T09:00:00.000Z')

    const audit = await fx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'attachments' AND entity_id = ?`, [a.id],
    )
    expect(audit?.n).toBe(1)
  })

  it('refuses a file larger than the limit', async () => {
    await expect(recordAttachment(fx.db, ctx(), {
      entity: 'bill', entityId: newId(), file: stored('2'.repeat(64), { sizeBytes: 11 * 1024 * 1024 }),
    })).rejects.toThrow(/larger than/)
  })
})

describe('the same photograph twice', () => {
  it('is one file on disk, cited by both documents', async () => {
    const sha = '3'.repeat(64)
    const first = await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: newId(), file: stored(sha) })
    const second = await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: newId(), file: stored(sha) })

    expect(first.id).not.toBe(second.id)
    expect(first.storedPath).toBe(second.storedPath)
  })

  /* Deleting one citation must not take the bytes the other one is still
     showing. */
  it('survives one of the two being removed', async () => {
    const sha = '4'.repeat(64)
    const first = await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: newId(), file: stored(sha) })
    const second = await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: newId(), file: stored(sha) })

    expect((await removeAttachment(fx.db, ctx(), first.id)).orphaned).toBeNull()
    expect((await removeAttachment(fx.db, ctx(), second.id)).orphaned).toBe(second.storedPath)
  })
})

describe('removing an attachment', () => {
  it('leaves no orphan file behind', async () => {
    const a = await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: newId(), file: stored('5'.repeat(64)) })
    expect((await removeAttachment(fx.db, ctx(), a.id)).orphaned).toBe(a.storedPath)
  })

  it('stops listing it', async () => {
    const billId = newId()
    const a = await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: billId, file: stored('6'.repeat(64)) })
    await removeAttachment(fx.db, ctx(), a.id)
    expect(await listAttachments(fx.db, 'bill', billId)).toHaveLength(0)
  })

  it('is quiet about an attachment that is already gone', async () => {
    const a = await recordAttachment(fx.db, ctx(), { entity: 'bill', entityId: newId(), file: stored('7'.repeat(64)) })
    await removeAttachment(fx.db, ctx(), a.id)
    expect((await removeAttachment(fx.db, ctx(), a.id)).orphaned).toBeNull()
  })
})

describe('a cancelled bill', () => {
  /* Evidence is the reason to keep a cancelled bill at all: the argument three
     months later is about why it was cancelled. */
  it('keeps its photographs', async () => {
    const productId = await makeProduct(fx.db, { baseRate: rupees(100) })
    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId,
        qtyChange: fromUnits(10),
        unitCost: rupees(50) as Money,
        voucherType: 'opening',
        voucherId: newId(),
        postingDate: '2026-01-01',
      })
    })
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error(draft.code)

    await recordAttachment(fx.db, ctx(), {
      entity: 'bill', entityId: draft.billId, file: stored('8'.repeat(64)),
    })

    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    await cancelBill(fx.db, { billId: draft.billId, reason: 'customer changed their mind', actorId: fx.adminId })

    expect(await listAttachments(fx.db, 'bill', draft.billId)).toHaveLength(1)
  })
})

describe('what a backup has to carry', () => {
  const now = new Date('2026-09-13T00:00:00.000Z')
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString()

  it('names each file once however many documents cite it', async () => {
    const sha = '9'.repeat(64)
    await recordAttachment(fx.db, { ...ctx(), now: () => daysAgo(1) }, {
      entity: 'bill', entityId: newId(), file: stored(sha),
    })
    await recordAttachment(fx.db, { ...ctx(), now: () => daysAgo(2) }, {
      entity: 'bill', entityId: newId(), file: stored(sha),
    })

    const carried = await attachmentsToCarry(fx.db, now, 90)
    expect(carried).toHaveLength(1)
    expect(carried[0]!.sha256).toBe(sha)
  })

  it('leaves the older photographs on disk and out of the archive', async () => {
    await recordAttachment(fx.db, { ...ctx(), now: () => daysAgo(10) }, {
      entity: 'bill', entityId: newId(), file: stored('a1'.padEnd(64, '0')),
    })
    await recordAttachment(fx.db, { ...ctx(), now: () => daysAgo(200) }, {
      entity: 'bill', entityId: newId(), file: stored('a2'.padEnd(64, '0')),
    })

    const carried = await attachmentsToCarry(fx.db, now, 90)
    expect(carried.map((c) => c.sha256)).toEqual(['a1'.padEnd(64, '0')])
  })

  it('does not carry what was deleted', async () => {
    const a = await recordAttachment(fx.db, { ...ctx(), now: () => daysAgo(1) }, {
      entity: 'bill', entityId: newId(), file: stored('b1'.padEnd(64, '0')),
    })
    await removeAttachment(fx.db, ctx(), a.id)
    expect(await attachmentsToCarry(fx.db, now, 90)).toHaveLength(0)
  })
})
