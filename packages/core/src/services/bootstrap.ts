import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import {
  ROLE_TEMPLATES, RESOURCES, noPermissions,
  type Resource, type ResourcePermissions,
} from '../integrity/permissions.js'
import { pagesNotYetKnown, grantPages } from './upgrade.js'
import { getSetting, setSetting, DEFAULT_PRICE_LIST } from './settings.js'

/* The settings table's reads and writes live in `settings.ts`, which imports
   nothing of the services. They are re-exported here because this is where
   every caller has always found them. */
export { getSetting, setSetting, forgetSetting, DEFAULT_PRICE_LIST } from './settings.js'

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
 *
 * Runs at head, after `migrate`, which is the order the app starts in. Its
 * writes name every column the table has, so against a database that has not
 * been migrated yet they would fail on the columns a later migration added.
 */
export async function bootstrap(db: SqlDriver, opts: BootstrapOptions): Promise<BootstrapResult> {
  const now = (opts.now ?? (() => new Date().toISOString()))()

  return db.transaction(async (tx) => {
    const roleIds: Record<string, string> = {}
    const newPages = await pagesNotYetKnown(tx)

    for (const template of ROLE_TEMPLATES) {
      const [existing] = await q(tx)
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.name, template.name))
      const roleId = existing?.id ?? newId()

      roleIds[template.name] = roleId

      // A template seeds a role once. Re-applying it on every start would undo
      // whatever the owner has since ticked on the Roles screen.
      if (existing) {
        await grantPages(tx, roleId, template.pages.filter((p) => newPages.has(p)))
        continue
      }

      await q(tx).insert(schema.roles).values({
        id: roleId,
        name: template.name,
        description: template.description,
        isSystem: 1,
        createdAt: now,
        updatedAt: now,
      })

      for (const resource of RESOURCES) {
        const declared = template.resources[resource]
        if (!declared) continue
        const perms: ResourcePermissions = { ...noPermissions(), ...declared }
        await upsertPermission(tx, roleId, resource, perms)
      }

      for (const page of template.pages) {
        // Nothing on conflict: this runs on every start, and a page the owner
        // has since switched off must stay switched off.
        await q(tx).insert(schema.rolePages)
          .values({ roleId, pageKey: page, visible: 1 })
          .onConflictDoNothing()
      }
    }

    const registerName = opts.registerName ?? 'Main Register'
    const registerPrefix = opts.registerPrefix ?? 'MR'
    let [register] = await q(tx)
      .select({ id: schema.registers.id })
      .from(schema.registers)
      .where(eq(schema.registers.name, registerName))
    if (!register) {
      const id = newId()
      await q(tx).insert(schema.registers).values({
        id, name: registerName, prefix: registerPrefix, createdAt: now, updatedAt: now,
      })
      register = { id }
    }

    /* The default is a setting since 043, not a column — an index cannot express
       a rule about a shop that two tills have to keep. Read here rather than
       through `defaultPriceListId` because that one filters archived lists, and
       a shop whose only list has been archived should not be given a second one
       by starting up. */
    const chosen = await getSetting(tx, DEFAULT_PRICE_LIST)
    let [priceList] = chosen === null || chosen === ''
      ? []
      : await q(tx)
        .select({ id: schema.priceLists.id })
        .from(schema.priceLists)
        .where(eq(schema.priceLists.id, chosen))
    if (!priceList) {
      const id = newId()
      const listName = opts.defaultPriceList ?? 'Retail'
      await q(tx).insert(schema.priceLists).values({
        id, name: listName, createdAt: now, updatedAt: now,
      })
      await setSetting(tx, DEFAULT_PRICE_LIST, id, now)
      priceList = { id }
    }

    await setSetting(tx, 'shop_name', opts.shopName, now)

    /* Which shop this is, minted once and never again. Setting up is what
       creates a shop; a second till *joins* one, and the difference is the whole
       of migration 024 — two databases each bootstrapped separately hold two
       Admin roles with two ids and one name, and no merge rule can reconcile
       that because they are not two versions of one thing. A till that has this
       and a till that has a different one are two shops, and the sync handshake
       refuses them before a row moves. */
    if (await getSetting(tx, 'shop_id') === null) {
      await setSetting(tx, 'shop_id', newId(), now)
    }

    return { roleIds, registerId: register.id, priceListId: priceList.id }
  })
}

async function upsertPermission(
  tx: SqlDriver,
  roleId: string,
  resource: Resource,
  perms: ResourcePermissions,
): Promise<void> {
  const ticks = {
    canRead: bit(perms.read),
    canCreate: bit(perms.create),
    canWrite: bit(perms.write),
    canDelete: bit(perms.delete),
    canSubmit: bit(perms.submit),
    canCancel: bit(perms.cancel),
    canAmend: bit(perms.amend),
  }
  await q(tx).insert(schema.rolePermissions)
    .values({ id: newId(), roleId, resource, ...ticks })
    .onConflictDoUpdate({
      target: [schema.rolePermissions.roleId, schema.rolePermissions.resource],
      set: ticks,
    })
}

function bit(b: boolean): number {
  return b ? 1 : 0
}
