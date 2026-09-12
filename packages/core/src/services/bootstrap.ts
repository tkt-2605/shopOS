import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import {
  ROLE_TEMPLATES, RESOURCES, noPermissions,
  type Resource, type ResourcePermissions,
} from '../integrity/permissions.js'
import { pagesNotYetKnown, grantPages } from './upgrade.js'

export interface BootstrapOptions {
  shopName: string
  registerName?: string
  registerPrefix?: string
  defaultPriceList?: string
  now?: () => string
}

export interface BootstrapResult {
  roleIds: Record<string, string>
  registerId: string
  priceListId: string
}

/**
 * Brings an empty database to a usable state. Idempotent — safe to run on every
 * app start, so a shop that upgrades into a new seeded role gets it.
 */
export async function bootstrap(db: SqlDriver, opts: BootstrapOptions): Promise<BootstrapResult> {
  const now = (opts.now ?? (() => new Date().toISOString()))()

  return db.transaction(async (tx) => {
    const roleIds: Record<string, string> = {}
    const newPages = await pagesNotYetKnown(tx)

    for (const template of ROLE_TEMPLATES) {
      const existing = await tx.get<{ id: string }>(`SELECT id FROM roles WHERE name = ?`, [template.name])
      const roleId = existing?.id ?? newId()

      roleIds[template.name] = roleId

      // A template seeds a role once. Re-applying it on every start would undo
      // whatever the owner has since ticked on the Roles screen.
      if (existing) {
        await grantPages(tx, roleId, template.pages.filter((p) => newPages.has(p)))
        continue
      }

      await tx.execute(
        `INSERT INTO roles (id, name, description, is_system, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [roleId, template.name, template.description, now, now],
      )

      for (const resource of RESOURCES) {
        const declared = template.resources[resource]
        if (!declared) continue
        const perms: ResourcePermissions = { ...noPermissions(), ...declared }
        await upsertPermission(tx, roleId, resource, perms)
      }

      for (const page of template.pages) {
        await tx.execute(
          `INSERT INTO role_pages (role_id, page_key, visible) VALUES (?, ?, 1)
           ON CONFLICT (role_id, page_key) DO NOTHING`,
          [roleId, page],
        )
      }
    }

    const registerName = opts.registerName ?? 'Main Register'
    const registerPrefix = opts.registerPrefix ?? 'MR'
    let register = await tx.get<{ id: string }>(`SELECT id FROM registers WHERE name = ?`, [registerName])
    if (!register) {
      const id = newId()
      await tx.execute(
        `INSERT INTO registers (id, name, prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [id, registerName, registerPrefix, now, now],
      )
      register = { id }
    }

    const listName = opts.defaultPriceList ?? 'Retail'
    let priceList = await tx.get<{ id: string }>(`SELECT id FROM price_lists WHERE is_default = 1`)
    if (!priceList) {
      const id = newId()
      await tx.execute(
        `INSERT INTO price_lists (id, name, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`,
        [id, listName, now, now],
      )
      priceList = { id }
    }

    await setSetting(tx, 'shop_name', opts.shopName, now)
    await setSetting(tx, 'schema_bootstrapped_at', now, now)

    return { roleIds, registerId: register.id, priceListId: priceList.id }
  })
}

async function upsertPermission(
  tx: SqlDriver,
  roleId: string,
  resource: Resource,
  perms: ResourcePermissions,
): Promise<void> {
  await tx.execute(
    `INSERT INTO role_permissions
       (id, role_id, resource, can_read, can_create, can_write, can_delete, can_submit, can_cancel, can_amend)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (role_id, resource) DO UPDATE SET
       can_read = excluded.can_read, can_create = excluded.can_create,
       can_write = excluded.can_write, can_delete = excluded.can_delete,
       can_submit = excluded.can_submit, can_cancel = excluded.can_cancel,
       can_amend = excluded.can_amend`,
    [
      newId(), roleId, resource,
      bit(perms.read), bit(perms.create), bit(perms.write),
      bit(perms.delete), bit(perms.submit), bit(perms.cancel), bit(perms.amend),
    ],
  )
}

export async function setSetting(db: SqlDriver, key: string, value: string, now?: string): Promise<void> {
  await db.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now ?? new Date().toISOString()],
  )
}

export async function getSetting(db: SqlDriver, key: string): Promise<string | null> {
  const row = await db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [key])
  return row?.value ?? null
}

function bit(b: boolean): number {
  return b ? 1 : 0
}
