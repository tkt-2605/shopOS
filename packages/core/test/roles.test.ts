import { describe, it, expect } from 'vitest'
import { freshDb } from './helpers.js'
import {
  listRoles, loadRoleMatrix, createRole, renameRole, saveRoleMatrix, deleteRole,
  wouldLeaveNoAdministrator,
} from '../src/services/roles.js'
import { loadPermissions, PAGES, RESOURCES, noPermissions, fullPermissions } from '../src/integrity/permissions.js'
import { bootstrap } from '../src/services/bootstrap.js'
import { createUser } from '../src/services/auth.js'
import type { Page, Resource, ResourcePermissions } from '../src/integrity/permissions.js'

function blank() {
  return {
    resources: Object.fromEntries(RESOURCES.map((r) => [r, noPermissions()])) as Record<Resource, ResourcePermissions>,
    pages: Object.fromEntries(PAGES.map((p) => [p, false])) as Record<Page, boolean>,
  }
}

describe('roles', () => {
  it('seeds the four templates and reports who uses them', async () => {
    const { db } = await freshDb()
    const roles = await listRoles(db)
    expect(roles.map((r) => r.name).sort()).toEqual(['Admin', 'Cashier', 'Manager', 'Stockist'])
    expect(roles.find((r) => r.name === 'Admin')!.userCount).toBe(1)
    expect(roles.every((r) => r.isSystem)).toBe(true)
  })

  it('returns a full grid, including resources the role was never granted', async () => {
    const { db, seed } = await freshDb()
    const matrix = (await loadRoleMatrix(db, seed.roleIds['Cashier']!))!
    expect(Object.keys(matrix.resources).sort()).toEqual([...RESOURCES].sort())
    expect(Object.keys(matrix.pages).sort()).toEqual([...PAGES].sort())
    expect(matrix.resources.bill!.submit).toBe(true)
    expect(matrix.resources.bill!.cancel).toBe(false)
    expect(matrix.pages.roles).toBe(false)
  })

  it('copies an existing role when asked', async () => {
    const { db, seed, adminId } = await freshDb()
    const result = await createRole(db, {
      name: 'Evening Cashier', copyFromId: seed.roleIds['Cashier']!, actorId: adminId,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const copy = (await loadRoleMatrix(db, result.roleId))!
    const source = (await loadRoleMatrix(db, seed.roleIds['Cashier']!))!
    expect(copy.resources).toEqual(source.resources)
    expect(copy.pages).toEqual(source.pages)
    expect(copy.isSystem).toBe(false)
  })

  it('refuses a duplicate name', async () => {
    const { db, adminId } = await freshDb()
    const result = await createRole(db, { name: 'Cashier', actorId: adminId })
    expect(result).toEqual({ ok: false, code: 'NAME_TAKEN' })
  })

  it('saves the grid and the permission loader sees it immediately', async () => {
    const { db, seed, adminId } = await freshDb()
    const cashier = seed.roleIds['Cashier']!
    const grid = blank()
    grid.resources.bill = { ...noPermissions(), read: true, create: true, submit: true, cancel: true }
    grid.pages.billing = true
    grid.pages.reports = true

    expect(await saveRoleMatrix(db, { roleId: cashier, ...grid, actorId: adminId })).toEqual({ ok: true, roleId: cashier })

    const perms = await loadPermissions(db, cashier)
    expect(perms.pages.has('billing')).toBe(true)
    expect(perms.pages.has('bills')).toBe(false)
    expect(perms.resources.bill!.cancel).toBe(true)
    expect(perms.resources.customer!.read).toBe(false)
  })

  it('will not let the shop tick away its own last administrator', async () => {
    const { db, seed, adminId } = await freshDb()
    const result = await saveRoleMatrix(db, { roleId: seed.roleIds['Admin']!, ...blank(), actorId: adminId })
    expect(result).toEqual({ ok: false, code: 'WOULD_LOCK_OUT' })

    // And the refused save changed nothing.
    const perms = await loadPermissions(db, seed.roleIds['Admin']!)
    expect(perms.pages.has('roles')).toBe(true)
    expect(perms.resources.role!.write).toBe(true)
  })

  it('allows stripping one administrator role while another remains', async () => {
    const { db, seed, adminId } = await freshDb()
    const second = await createRole(db, { name: 'Owner', copyFromId: seed.roleIds['Admin']!, actorId: adminId })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    await createUser(db, { username: 'owner', password: 'secret1', roleId: second.roleId, actorId: adminId })

    const result = await saveRoleMatrix(db, { roleId: seed.roleIds['Admin']!, ...blank(), actorId: adminId })
    expect(result.ok).toBe(true)
  })

  it('refuses to delete a system role or one still in use', async () => {
    const { db, seed, adminId } = await freshDb()
    expect(await deleteRole(db, { roleId: seed.roleIds['Admin']!, actorId: adminId }))
      .toEqual({ ok: false, code: 'SYSTEM_ROLE' })

    const made = await createRole(db, { name: 'Temp', actorId: adminId })
    if (!made.ok) throw new Error('setup failed')
    await createUser(db, { username: 'temp', password: 'secret1', roleId: made.roleId, actorId: adminId })

    const result = await deleteRole(db, { roleId: made.roleId, actorId: adminId })
    expect(result.ok).toBe(false)
    if (result.ok) return
    if (result.code !== 'IN_USE') throw new Error(`expected IN_USE, got ${result.code}`)
    expect(result.message).toContain('temp')
  })

  it('deletes an unused role along with its grid', async () => {
    const { db, adminId } = await freshDb()
    const made = await createRole(db, { name: 'Temp', actorId: adminId })
    if (!made.ok) throw new Error('setup failed')

    expect(await deleteRole(db, { roleId: made.roleId, actorId: adminId })).toEqual({ ok: true })
    expect(await loadRoleMatrix(db, made.roleId)).toBeNull()
    const leftovers = await db.query(`SELECT * FROM role_pages WHERE role_id = ?`, [made.roleId])
    expect(leftovers).toHaveLength(0)
  })

  it('renames without disturbing the grid', async () => {
    const { db, seed, adminId } = await freshDb()
    const before = (await loadRoleMatrix(db, seed.roleIds['Stockist']!))!
    await renameRole(db, { roleId: seed.roleIds['Stockist']!, name: 'Store Keeper', actorId: adminId })
    const after = (await loadRoleMatrix(db, seed.roleIds['Stockist']!))!
    expect(after.name).toBe('Store Keeper')
    expect(after.resources).toEqual(before.resources)
  })

  /* The seeded templates are a starting point, not a policy that reasserts itself:
     bootstrap runs on every launch. */
  it('does not undo an owner edit on the next start', async () => {
    const { db, seed, adminId } = await freshDb()
    const cashier = seed.roleIds['Cashier']!
    const grid = blank()
    grid.resources.bill = fullPermissions()
    grid.pages.billing = true
    await saveRoleMatrix(db, { roleId: cashier, ...grid, actorId: adminId })

    await bootstrap(db, { shopName: 'Test Shop' })

    const perms = await loadPermissions(db, cashier)
    expect(perms.resources.bill!.cancel).toBe(true)
    expect(perms.pages.has('bills')).toBe(false)
  })

  it('knows when a staff change would leave nobody able to administer', async () => {
    const { db, seed, adminId } = await freshDb()
    expect(await wouldLeaveNoAdministrator(db, { userId: adminId, isActive: false })).toBe(true)
    expect(await wouldLeaveNoAdministrator(db, { userId: adminId, roleId: seed.roleIds['Cashier']! })).toBe(true)

    const other = await createUser(db, { username: 'boss', password: 'secret1', roleId: seed.roleIds['Admin']!, actorId: adminId })
    expect(other.ok).toBe(true)
    expect(await wouldLeaveNoAdministrator(db, { userId: adminId, isActive: false })).toBe(false)
  })
})

describe('upgrading into a new page', () => {
  /* Shipping a new screen must reach shops that already configured their roles,
     without reopening pages they closed. */
  it('gives a page nobody has ever seen to the roles whose template names it', async () => {
    const { db, seed } = await freshDb()
    await db.execute(`DELETE FROM role_pages WHERE page_key = 'suppliers'`)

    await bootstrap(db, { shopName: 'Test Shop' })

    const admin = (await loadRoleMatrix(db, seed.roleIds['Admin']!))!
    const stockist = (await loadRoleMatrix(db, seed.roleIds['Stockist']!))!
    const cashier = (await loadRoleMatrix(db, seed.roleIds['Cashier']!))!

    expect(admin.pages.suppliers).toBe(true)
    expect(stockist.pages.suppliers).toBe(true)
    // Not in the Cashier template, so the cashier still does not get it.
    expect(cashier.pages.suppliers).toBe(false)
  })

  it('leaves a page the owner switched off switched off', async () => {
    const { db, seed, adminId } = await freshDb()
    const admin = (await loadRoleMatrix(db, seed.roleIds['Admin']!))!
    admin.pages.suppliers = false
    await saveRoleMatrix(db, {
      roleId: admin.id, resources: admin.resources, pages: admin.pages, actorId: adminId,
    })

    await bootstrap(db, { shopName: 'Test Shop' })

    expect((await loadRoleMatrix(db, seed.roleIds['Admin']!))!.pages.suppliers).toBe(false)
  })
})
