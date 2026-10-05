import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  ENFORCED, RESOURCES, PermissionError, requirePermission,
} from '../src/integrity/permissions.js'
import { createUser } from '../src/services/auth.js'
import { createBill, submitBill, cancelBill, saveDraft, amendBill } from '../src/services/billing.js'
import { closeBooks } from '../src/services/books.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Permissions are the services' to enforce, not only the screens' to hide.
 *
 * From the review of 4 October: every service took an `actorId`, wrote it in
 * the audit log, and never asked whether that person was allowed. The Roles
 * screen's tickboxes were honoured only by hiding buttons, so the Stock In page
 * -- which checked nothing -- posted stock for a role with "submit" unticked.
 */

const SERVICES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services')

function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return everyFile(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

/** Every pair a service checks: `requirePermission(…, 'resource', 'capability')`, or a `['resource', 'capability']` table. */
function checkedInServices(): Set<string> {
  const found = new Set<string>()
  const call = /requirePermission\([^,]+,[^,]+,\s*'([a-z_]+)',\s*'([a-z]+)'\)/g
  const table = /\[\s*'([a-z_]+)',\s*'([a-z]+)'\s*\]/g
  for (const file of everyFile(SERVICES)) {
    const text = readFileSync(file, 'utf8')
    for (const [, r, c] of text.matchAll(call)) found.add(`${r}.${c}`)
    if (text.includes('requirePermission(db, ctx.actorId, ...')) {
      for (const [, r, c] of text.matchAll(table)) found.add(`${r}.${c}`)
    }
  }
  return found
}

function claimed(): Set<string> {
  return new Set(RESOURCES.flatMap((r) => ENFORCED[r].map((c) => `${r}.${c}`)))
}

describe('what the services enforce', () => {
  it('is every tickbox the Roles screen offers', () => {
    const inServices = checkedInServices()
    const unchecked = [...claimed()].filter((pair) => !inServices.has(pair))
    expect(unchecked, `offered on the Roles screen but no service checks it: ${unchecked.join(', ')}`).toEqual([])
  })

  it('and nothing the Roles screen does not offer', () => {
    const offered = claimed()
    const hidden = [...checkedInServices()].filter((pair) => !offered.has(pair))
    expect(hidden, `checked by a service but absent from ENFORCED: ${hidden.join(', ')}`).toEqual([])
  })
})

let fx: Fixture
let product: string
beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
})
afterEach(async () => { await fx.db.close() })

async function staff(role: string, username = role.toLowerCase()): Promise<string> {
  const made = await createUser(fx.db, {
    username, password: 'counter-9', roleId: fx.seed.roleIds[role]!, actorId: fx.adminId,
  })
  if (!made.ok) throw new Error(made.code)
  return made.userId
}

describe('the check', () => {
  it('refuses nobody, a stranger, and a person whose account is off', async () => {
    await expect(requirePermission(fx.db, null, 'bill', 'create')).rejects.toBeInstanceOf(PermissionError)
    await expect(requirePermission(fx.db, 'nobody-of-that-id', 'bill', 'create')).rejects.toBeInstanceOf(PermissionError)
    const cashier = await staff('Cashier')
    await fx.db.execute(`UPDATE users SET is_active = 0 WHERE id = ?`, [cashier])
    await expect(requirePermission(fx.db, cashier, 'bill', 'create')).rejects.toBeInstanceOf(PermissionError)
  })

  it('reads the role as it stands, so a change binds at once', async () => {
    const cashier = await staff('Cashier')
    await requirePermission(fx.db, cashier, 'bill', 'create')
    await fx.db.execute(
      `UPDATE role_permissions SET can_create = 0 WHERE role_id = ? AND resource = 'bill'`,
      [fx.seed.roleIds['Cashier']!],
    )
    await expect(requirePermission(fx.db, cashier, 'bill', 'create')).rejects.toBeInstanceOf(PermissionError)
  })
})

describe('a cashier, as seeded', () => {
  it('rings up and takes payment', async () => {
    const cashier = await staff('Cashier')
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(1) }], actorId: cashier,
    })
    if (!draft.ok) throw new Error(draft.code)
    const done = await submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: cashier,
    })
    expect(done.ok).toBe(true)
  })

  it('cannot cancel the bill afterwards, nor close the books', async () => {
    const cashier = await staff('Cashier')
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(1) }], actorId: cashier,
    })
    if (!draft.ok) throw new Error(draft.code)
    await submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: cashier,
    })
    await expect(cancelBill(fx.db, { billId: draft.billId, actorId: cashier })).rejects.toBeInstanceOf(PermissionError)
    await expect(closeBooks(fx.db, { through: '2020-01-01', actorId: cashier })).rejects.toBeInstanceOf(PermissionError)
  })

  it('cannot type a price of their own', async () => {
    const cashier = await staff('Cashier')
    await expect(createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: product, qty: fromUnits(1), rateOverride: rupees(50) as Money }],
      actorId: cashier,
    })).rejects.toBeInstanceOf(PermissionError)
  })

  it('can carry on with a held bill a manager priced, but not change that price', async () => {
    const manager = await staff('Manager')
    const cashier = await staff('Cashier')
    const priced = { productId: product, qty: fromUnits(1), rateOverride: rupees(50) as Money }
    const draft = await createBill(fx.db, { registerId: fx.seed.registerId, lines: [priced], actorId: manager })
    if (!draft.ok) throw new Error(draft.code)

    // The autosave sends the manager's typed rate back unchanged, with a second item.
    const resumed = await saveDraft(fx.db, {
      billId: draft.billId, registerId: fx.seed.registerId, actorId: cashier,
      lines: [priced, { productId: product, qty: fromUnits(2) }],
    })
    expect(resumed.ok).toBe(true)

    await expect(saveDraft(fx.db, {
      billId: draft.billId, registerId: fx.seed.registerId, actorId: cashier,
      lines: [{ ...priced, rateOverride: rupees(40) as Money }],
    })).rejects.toBeInstanceOf(PermissionError)
  })
})

describe('amending', () => {
  it('a cancelled bill a manager priced is open to a cashier, who may sell but not set prices', async () => {
    /* Amending used to send every line back as a typed rate, which once the
       services checked roles would have asked a cashier for the right to set
       prices. The rates are the original's, carried, not decided again. */
    const manager = await staff('Manager')
    const cashier = await staff('Cashier')
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: product, qty: fromUnits(1), rateOverride: rupees(80) as Money }],
      actorId: manager,
    })
    if (!draft.ok) throw new Error(draft.code)
    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: manager })
    await cancelBill(fx.db, { billId: draft.billId, actorId: manager })

    const amended = await amendBill(fx.db, { billId: draft.billId, actorId: cashier })
    if (!amended.ok) throw new Error(amended.code)
    expect(amended.grandTotal).toBe(rupees(80))
  })
})

describe('the first person on a till', () => {
  it('may be made with nobody signed in, and nobody after them may', async () => {
    // `freshDb` has already made the administrator, so this is the second person.
    await expect(createUser(fx.db, {
      username: 'walkin', password: 'counter-9', roleId: fx.seed.roleIds['Admin']!,
    })).rejects.toBeInstanceOf(PermissionError)
  })
})
