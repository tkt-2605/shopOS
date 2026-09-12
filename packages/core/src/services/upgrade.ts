import type { SqlDriver } from '../db/driver.js'
import { ROLE_TEMPLATES, PAGES } from '../integrity/permissions.js'

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
export async function applyUpgrades(db: SqlDriver): Promise<{ pagesGranted: string[] }> {
  const granted: string[] = []

  await db.transaction(async (tx) => {
    const newPages = await pagesNotYetKnown(tx)
    if (newPages.size === 0) return

    for (const template of ROLE_TEMPLATES) {
      const role = await tx.get<{ id: string }>(`SELECT id FROM roles WHERE name = ?`, [template.name])
      if (!role) continue

      const pages = template.pages.filter((p) => newPages.has(p))
      await grantPages(tx, role.id, pages)
      granted.push(...pages)
    }
  })

  return { pagesGranted: [...new Set(granted)] }
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
  const seen = await tx.query<{ page_key: string }>(`SELECT DISTINCT page_key FROM role_pages`)
  const known = new Set(seen.map((r) => r.page_key))
  return new Set(PAGES.filter((p) => !known.has(p)))
}

export async function grantPages(tx: SqlDriver, roleId: string, pages: readonly string[]): Promise<void> {
  for (const page of pages) {
    await tx.execute(
      `INSERT INTO role_pages (role_id, page_key, visible) VALUES (?, ?, 1)
       ON CONFLICT (role_id, page_key) DO NOTHING`,
      [roleId, page],
    )
  }
}
