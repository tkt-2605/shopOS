import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDocument, editDraftDocument, submitDocument, loadDocument } from '../src/services/documents.js'
import { createUser } from '../src/services/auth.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * A draft quotation, sales order or purchase order, opened again and changed
 * before it is issued (`documents/edit.ts`). It keeps its number, is priced as
 * a new one would be, and once issued it is not changed at all.
 */

let fx: Fixture
let pen: string
let book: string
let school: string
let college: string

beforeEach(async () => {
  fx = await freshDb()
  pen = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(10), taxRateBp: 0 })
  book = await makeProduct(fx.db, { name: 'Book', baseRate: rupees(50), taxRateBp: 0 })
  school = await makeCustomer(fx.db, 'Sri Vidya School')
  college = await makeCustomer(fx.db, 'Arts College')
})
afterEach(async () => { await fx.db.close() })

async function draft() {
  const made = await createDocument(fx.db, {
    kind: 'quotation', registerId: fx.seed.registerId, customerId: school,
    lines: [{ productId: pen, qty: fromUnits(10) }], notes: 'Term one', actorId: fx.adminId,
  })
  if (!made.ok) throw new Error(made.code)
  return made
}

describe('a draft opened again', () => {
  it('takes new lines, a new customer and a new note, and keeps its number', async () => {
    const made = await draft()
    const edited = await editDraftDocument(fx.db, {
      documentId: made.documentId, customerId: college, validUntil: '2026-11-30', notes: 'Term two',
      lines: [{ productId: pen, qty: fromUnits(5) }, { productId: book, qty: fromUnits(2), rateOverride: rupees(45) }],
      actorId: fx.adminId,
    })
    expect(edited).toEqual({ ok: true, documentId: made.documentId, docNo: made.docNo, grandTotal: rupees(140) })

    const doc = await loadDocument(fx.db, made.documentId)
    expect(doc).toMatchObject({
      docNo: made.docNo, docstatus: 0, customerId: college, partyName: 'Arts College',
      validUntil: '2026-11-30', notes: 'Term two', grandTotal: rupees(140),
    })
    expect(doc?.items.map((i) => [i.productName, i.qty, i.rate])).toEqual([
      ['Pen', fromUnits(5), rupees(10)], ['Book', fromUnits(2), rupees(45)],
    ])
  })

  it('is refused once it has been issued, and the issued one is left exactly as it was', async () => {
    const made = await draft()
    await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })
    expect(await editDraftDocument(fx.db, {
      documentId: made.documentId, customerId: school, lines: [{ productId: book, qty: fromUnits(1) }], actorId: fx.adminId,
    })).toMatchObject({ ok: false, code: 'NOT_A_DRAFT' })
    const doc = await loadDocument(fx.db, made.documentId)
    expect(doc?.items.map((i) => i.productName)).toEqual(['Pen'])
  })

  it('is refused for a document that is not here, or with no lines or no customer', async () => {
    const made = await draft()
    expect(await editDraftDocument(fx.db, {
      documentId: newId(), customerId: school, lines: [{ productId: pen, qty: fromUnits(1) }], actorId: fx.adminId,
    })).toMatchObject({ ok: false, code: 'UNKNOWN_DOCUMENT' })
    expect(await editDraftDocument(fx.db, {
      documentId: made.documentId, customerId: school, lines: [], actorId: fx.adminId,
    })).toMatchObject({ ok: false, code: 'NO_LINES' })
    expect(await editDraftDocument(fx.db, {
      documentId: made.documentId, customerId: null, lines: [{ productId: pen, qty: fromUnits(1) }], actorId: fx.adminId,
    })).toMatchObject({ ok: false, code: 'PARTY_REQUIRED' })
    expect((await loadDocument(fx.db, made.documentId))?.items).toHaveLength(1)
  })

  it('is written to the audit trail', async () => {
    const made = await draft()
    await editDraftDocument(fx.db, {
      documentId: made.documentId, customerId: school, lines: [{ productId: book, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    const row = await fx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'document' AND entity_id = ? AND action = 'update'`, [made.documentId],
    )
    expect(row?.n).toBe(1)
  })

  it('is refused to somebody who may not make documents, such as a cashier', async () => {
    const made = await draft()
    const role = await fx.db.get<{ id: string }>(`SELECT id FROM roles WHERE name = 'Cashier'`)
    const cashier = await createUser(fx.db, { username: 'cash', password: 'counter-9', roleId: role!.id, actorId: fx.adminId })
    if (!cashier.ok) throw new Error(cashier.code)
    await expect(editDraftDocument(fx.db, {
      documentId: made.documentId, customerId: school, lines: [{ productId: book, qty: fromUnits(1) }], actorId: cashier.userId,
    })).rejects.toThrow(/create on document/)
    expect((await loadDocument(fx.db, made.documentId))?.items.map((i) => i.productName)).toEqual(['Pen'])
  })
})
