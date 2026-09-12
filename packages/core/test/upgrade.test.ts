import { describe, it, expect } from 'vitest'
import { freshDb } from './helpers.js'
import { applyUpgrades } from '../src/services/upgrade.js'
import { loadRoleMatrix, saveRoleMatrix } from '../src/services/roles.js'

describe('applying an upgrade to a running shop', () => {
  it('does nothing when the shop already knows every page', async () => {
    const { db } = await freshDb()
    expect(await applyUpgrades(db)).toEqual({ pagesGranted: [] })
  })

  it('grants a page the shop has never seen, to the roles whose template names it', async () => {
    const { db, seed } = await freshDb()
    await db.execute(`DELETE FROM role_pages WHERE page_key = 'suppliers'`)

    const result = await applyUpgrades(db)
    expect(result.pagesGranted).toEqual(['suppliers'])

    expect((await loadRoleMatrix(db, seed.roleIds['Admin']!))!.pages.suppliers).toBe(true)
    expect((await loadRoleMatrix(db, seed.roleIds['Stockist']!))!.pages.suppliers).toBe(true)
    // Not in the Cashier template.
    expect((await loadRoleMatrix(db, seed.roleIds['Cashier']!))!.pages.suppliers).toBe(false)
  })

  it('leaves a page the owner switched off switched off', async () => {
    const { db, seed, adminId } = await freshDb()
    const admin = (await loadRoleMatrix(db, seed.roleIds['Admin']!))!
    admin.pages.suppliers = false
    await saveRoleMatrix(db, {
      roleId: admin.id, resources: admin.resources, pages: admin.pages, actorId: adminId,
    })

    expect(await applyUpgrades(db)).toEqual({ pagesGranted: [] })
    expect((await loadRoleMatrix(db, seed.roleIds['Admin']!))!.pages.suppliers).toBe(false)
  })

  it('is safe to run twice', async () => {
    const { db } = await freshDb()
    await db.execute(`DELETE FROM role_pages WHERE page_key = 'suppliers'`)
    await applyUpgrades(db)
    expect(await applyUpgrades(db)).toEqual({ pagesGranted: [] })
  })

  it('ignores a role the shop has renamed away from its template', async () => {
    const { db } = await freshDb()
    await db.execute(`DELETE FROM role_pages WHERE page_key = 'suppliers'`)
    await db.execute(`UPDATE roles SET name = 'Store Keeper' WHERE name = 'Stockist'`)

    const result = await applyUpgrades(db)
    expect(result.pagesGranted).toEqual(['suppliers'])

    const renamed = await db.get<{ id: string }>(`SELECT id FROM roles WHERE name = 'Store Keeper'`)
    const row = await db.get<{ visible: number }>(
      `SELECT visible FROM role_pages WHERE role_id = ? AND page_key = 'suppliers'`, [renamed!.id],
    )
    expect(row).toBeUndefined()
  })
})
