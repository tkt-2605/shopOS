import type { Migration } from '@shopos/core'

/**
 * Every .sql file in the core migrations folder, in order, with the version taken
 * from the filename. Globbed rather than listed: a hand-kept list is how the
 * previous system ended up with a schema that differed between installs, because
 * adding the file and adding the list entry are two steps and one gets forgotten.
 */
export const MIGRATIONS: Migration[] = Object.entries(
  import.meta.glob('../../../../packages/core/migrations/*.sql', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)
  .map(([path, sql]) => {
    const name = path.split('/').pop()!
    const version = Number(name.split('_')[0])
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`migration filename must start with its version: ${name}`)
    }
    return { version, name, sql: sql as string }
  })
  .sort((a, b) => a.version - b.version)

/**
 * The newest schema this build understands. Restore refuses a backup above it,
 * because `migrate` only runs forward: a database from a newer ShopOS has
 * nothing pending and would otherwise be opened silently against queries that do
 * not match it.
 */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
