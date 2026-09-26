import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  migrate, bootstrap, newId, recordOpeningBalance, Money, Receipt,
  type SqlDriver, type BootstrapResult,
} from '@shopos/core'
/* Around `@shopos/core` for the reason `invoiceFromBill.test.tsx` gives: the
   node driver is never reachable from the webview, and a test is the one caller
   allowed to reach around that. */
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import {
  printStatement, listPrinters, defaultPrinter, setReceiptPrinter, type ReceiptPrinter,
} from '../src/core/print'

/**
 * The roll printer is a seam, and this is the test double on the other side.
 *
 * Until the printer was an interface the only way to see what a statement put
 * on paper was a thermal printer on the desk. Now the bytes a shop's printer
 * would be sent arrive here instead, so the whole path -- the ledger read, the
 * layout, the fold to what the printer's code page has -- is checked on a
 * machine with no printer at all.
 */

let db: SqlDriver
let seed: BootstrapResult
let adminId: string
let sent: { printer: string | null; text: string }[]
let restore: () => void

function recording(overrides: Partial<ReceiptPrinter> = {}): ReceiptPrinter {
  return {
    list: async () => ['Counter TVS', 'Office A4'],
    defaultName: async () => 'Counter TVS',
    print: async (printer, bytes) => {
      sent.push({ printer, text: new TextDecoder().decode(new Uint8Array(bytes)) })
    },
    ...overrides,
  }
}

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  seed = await bootstrap(db, { shopName: 'TRT Stationery' })
  adminId = newId()
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
    [adminId, seed.roleIds['Admin']!, now, now],
  )
  sent = []
  restore = setReceiptPrinter(recording())
})

afterEach(async () => {
  restore()
  await db.close()
})

async function customerOwing(name: string, rupees: number): Promise<string> {
  const id = newId()
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO customers (id, name, code, phone, created_at, updated_at) VALUES (?, ?, 'C-7', '9840000000', ?, ?)`,
    [id, name, now, now],
  )
  const opened = await recordOpeningBalance(db, {
    customerId: id, amount: Money.rupees(rupees), registerId: seed.registerId, actorId: adminId,
  })
  if (!opened.ok) throw new Error(opened.code)
  return id
}

describe('the roll printer', () => {
  it("prints a customer's statement through whatever printer it is given", async () => {
    const id = await customerOwing('Meena Stores', 450)

    expect(await printStatement(db, id)).toEqual({ ok: true })
    expect(sent).toHaveLength(1)

    const lines = Receipt.visibleLines(sent[0]!.text)
    expect(lines.some((l) => l.includes('STATEMENT OF ACCOUNT'))).toBe(true)
    expect(lines.some((l) => l.includes('Meena Stores') && l.includes('C-7'))).toBe(true)
    expect(lines.some((l) => l.includes('BALANCE DUE'))).toBe(true)
    // No printer chosen on this machine: Windows' default, which is what null says.
    expect(sent[0]!.printer).toBeNull()
  })

  it('sends nothing for a customer it cannot find, and says so', async () => {
    const result = await printStatement(db, 'nobody')
    expect(result).toEqual({ ok: false, message: 'That customer could not be found.' })
    expect(sent).toEqual([])
  })

  it('turns a printer that fails into a sentence, not a throw', async () => {
    restore()
    restore = setReceiptPrinter(recording({ print: async () => { throw 'Printer is offline' } }))
    const id = await customerOwing('Meena Stores', 450)

    expect(await printStatement(db, id)).toEqual({ ok: false, message: 'Printer is offline' })
  })

  it('lists what the machine has, and nothing when it cannot ask', async () => {
    expect(await listPrinters()).toEqual(['Counter TVS', 'Office A4'])
    expect(await defaultPrinter()).toBe('Counter TVS')

    restore()
    restore = setReceiptPrinter(recording({
      list: async () => { throw new Error('no bridge') },
      defaultName: async () => { throw new Error('no bridge') },
    }))
    expect(await listPrinters()).toEqual([])
    expect(await defaultPrinter()).toBeNull()
  })

  it('puts the previous printer back when asked', async () => {
    const other: ReceiptPrinter = recording({ list: async () => ['Somewhere else'] })
    const undo = setReceiptPrinter(other)
    expect(await listPrinters()).toEqual(['Somewhere else'])
    undo()
    expect(await listPrinters()).toEqual(['Counter TVS', 'Office A4'])
  })
})
