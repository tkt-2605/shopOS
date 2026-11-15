import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import {
  migrate, bootstrap, newId, loadFeatures, createDocument, submitDocument, Quantity,
  type SqlDriver, type BootstrapResult,
} from '@shopos/core'
/* Reached around `@shopos/core` on purpose: see `invoiceFromBill.test.tsx`. */
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { loadPermissions } from '../../../packages/core/src/integrity/permissions'
import type { DeskConfig } from '../src/ui/documentDesk/types'

/**
 * An issued quotation, corrected from the screen.
 *
 * Issued meant finished: the only way out of a wrong quantity was to cancel it
 * and type the whole thing again. Edit now opens it in the same form, and
 * saving cancels it and issues the corrected one, naming it.
 */

let db: SqlDriver
let seed: BootstrapResult
let core: Record<string, unknown>

vi.mock('../src/core/CoreProvider', () => ({
  useCore: () => core,
  useUser: () => core['user'],
  useDb: () => core['db'],
}))

const { DocumentDesk } = await import('../src/ui/DocumentDesk')

const config: DeskConfig = {
  kinds: ['quotation'],
  party: 'customer',
  labels: { quotation: { name: 'Quotation', plural: 'Quotations', note: '' } },
}

let docNo = ''
let documentId = ''

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  seed = await bootstrap(db, { shopName: 'TRT Stationery' })
  const adminId = newId()
  const now = new Date().toISOString()
  const roleId = seed.roleIds['Admin']!
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
    [adminId, roleId, now, now],
  )
  const pen = newId()
  await db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, hsn_code, created_at, updated_at)
     VALUES (?, 'Ball Pen Blue', 1000, 1200, '9608', ?, ?)`,
    [pen, now, now],
  )
  const customerId = newId()
  await db.execute(
    `INSERT INTO customers (id, name, created_at, updated_at) VALUES (?, 'Ravi Traders', ?, ?)`,
    [customerId, now, now],
  )
  const made = await createDocument(db, {
    kind: 'quotation', registerId: seed.registerId, customerId,
    lines: [{ productId: pen, qty: Quantity.fromUnits(5) }], actorId: adminId,
  })
  if (!made.ok) throw new Error(made.code)
  await submitDocument(db, { documentId: made.documentId, actorId: adminId })
  docNo = made.docNo
  documentId = made.documentId

  core = {
    db,
    registerId: seed.registerId,
    features: await loadFeatures(db),
    taxScheme: 'regular',
    user: {
      id: adminId, username: 'admin', fullName: 'Administrator', roleId, roleName: 'Admin',
      permissions: await loadPermissions(db, roleId),
    },
  }
})

afterEach(async () => {
  cleanup()
  await db.close()
})

describe('an issued quotation', () => {
  it('opens to edit, and saved, is cancelled with the corrected one issued in its place', async () => {
    render(<DocumentDesk config={config} />)
    fireEvent.click(await screen.findByText(docNo))
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Edit'))

    const form = await screen.findByRole('dialog', { name: new RegExp(`Correct quotation ${docNo}`) })
    await waitFor(() => expect(within(form).getAllByText(/Ball Pen Blue/).length).toBeGreaterThan(0))
    expect(within(form).queryByText('Save draft')).toBeNull()
    const qty = form.querySelector<HTMLInputElement>('input.qty-input')!
    fireEvent.change(qty, { target: { value: '8' } })
    fireEvent.click(within(form).getByText('Save correction'))

    await waitFor(() => expect(document.body.textContent).toContain(`Quotation ${docNo} corrected.`))
    const rows = await db.query<{ id: string; docstatus: number; amended_from: string | null; qty: number }>(
      `SELECT d.id, d.docstatus, d.amended_from, i.qty FROM documents d JOIN document_items i ON i.document_id = d.id
        ORDER BY d.created_at`)
    expect(rows).toMatchObject([
      { id: documentId, docstatus: 2, amended_from: null, qty: Quantity.fromUnits(5) },
      { docstatus: 1, amended_from: documentId, qty: Quantity.fromUnits(8) },
    ])
  })
})
