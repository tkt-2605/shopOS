import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { ROLE_TEMPLATES, PAGES, RESOURCES, type Resource, type ResourcePermissions } from '../integrity/permissions.js'
import { backfillCustomerCodes } from './customers.js'
import { newId } from '../ids.js'
import { postMissingGl } from './ledger.js'

/**
 * What a new version of ShopOS has to do to a shop that is already running.
 *
 * Separate from bootstrap on purpose: bootstrap sets up an empty database and
 * would need a shop name and a counter to do it, while this runs on every start
 * of an existing shop and must never overwrite a decision the owner has made.
 *
 * Schema changes belong in a migration. This is for the data a migration cannot
 * reasonably know — chiefly which of the shop's roles should see a screen that
 * did not exist when they configured them.
 */
export async function applyUpgrades(db: SqlDriver): Promise<{ pagesGranted: string[]; codesGiven: number }> {
  const granted: string[] = []

  /* Customers entered before the code existed have none, and a screen that shows
     a blank in the column meant to identify people is worse than no column. Done
     here rather than in a migration because the codes have to dodge whatever the
     shop has typed by hand, and a migration that hit the unique constraint would
     leave the shop unable to open its own till. */
  const codesGiven = await backfillCustomerCodes(db)

  /* The books for everything submitted before the ledger existed, or that
     arrived from a till still on an older build. Nothing, on an ordinary day. */
  await postMissingGl(db)

  await db.transaction(async (tx) => {
    const newPages = await pagesNotYetKnown(tx)
    const newResources = await resourcesNotYetKnown(tx)
    if (newPages.size === 0 && newResources.size === 0) return

    for (const template of ROLE_TEMPLATES) {
      const [role] = await q(tx)
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.name, template.name))
      if (!role) continue

      const pages = template.pages.filter((p) => newPages.has(p))
      await grantPages(tx, role.id, pages)
      granted.push(...pages)

      for (const resource of newResources) {
        const allowed = template.resources[resource as Resource]
        if (allowed) await grantResource(tx, role.id, resource, allowed)
      }
    }
  })

  return { pagesGranted: [...new Set(granted)], codesGiven }
}

/**
 * Pages this shop has never had a say about. Read once, before any role is
 * touched — a page becomes "known" the moment the first role is granted it, so
 * asking per role would give it to Admin and nobody else.
 *
 * A page the owner deliberately switched off has a row with visible = 0, so it is
 * already known and stays off. That distinction is the whole point.
 */
export async function pagesNotYetKnown(tx: SqlDriver): Promise<Set<string>> {
  const seen = await q(tx)
    .selectDistinct({ pageKey: schema.rolePages.pageKey })
    .from(schema.rolePages)
  const known = new Set(seen.map((r) => r.pageKey))
  return new Set(PAGES.filter((p) => !known.has(p)))
}

/**
 * The same idea for what a role may *do*, not only what it may see.
 *
 * A version that adds a resource — quotations and purchase orders added
 * `document` — leaves every existing role with no row for it, and a missing row
 * reads as "not permitted". Without this the owner of a shop that has been
 * running for a year would find the new screen granted and every button on it
 * refused.
 *
 * Read once and across all roles, for the reason `pagesNotYetKnown` is: the
 * first grant makes the resource known, so asking per role would give it to
 * whichever role was looked at first and to nobody else.
 */
export async function resourcesNotYetKnown(tx: SqlDriver): Promise<Set<string>> {
  const seen = await q(tx)
    .selectDistinct({ resource: schema.rolePermissions.resource })
    .from(schema.rolePermissions)
  const known = new Set(seen.map((r) => r.resource))
  return new Set(RESOURCES.filter((r) => !known.has(r)))
}

export async function grantResource(
  tx: SqlDriver,
  roleId: string,
  resource: string,
  allowed: Partial<ResourcePermissions>,
): Promise<void> {
  /* Nothing on conflict, unlike the seed in `bootstrap.ts`: this runs against a
     shop that has been configured, and a role already holding a row for this
     resource has had the owner's answer written into it. */
  await q(tx).insert(schema.rolePermissions)
    .values({
      id: newId(),
      roleId,
      resource,
      canRead: allowed.read ? 1 : 0,
      canCreate: allowed.create ? 1 : 0,
      canWrite: allowed.write ? 1 : 0,
      canDelete: allowed.delete ? 1 : 0,
      canSubmit: allowed.submit ? 1 : 0,
      canCancel: allowed.cancel ? 1 : 0,
      canAmend: allowed.amend ? 1 : 0,
    })
    .onConflictDoNothing()
}

export async function grantPages(tx: SqlDriver, roleId: string, pages: readonly string[]): Promise<void> {
  for (const page of pages) {
    await q(tx).insert(schema.rolePages)
      .values({ roleId, pageKey: page, visible: 1 })
      .onConflictDoNothing()
  }
}
