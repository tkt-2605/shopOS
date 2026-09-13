import { EXPECTED_SCHEMA_VERSION, type Migration } from '@shopos/core'

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

/**
 * Whether this bundle is carrying the migrations its own code needs.
 *
 * `import.meta.glob` is resolved when the bundle is built, but the TypeScript
 * around it is hot-reloaded. So an app left running while a migration file is
 * added keeps the old set of .sql files and starts querying columns the database
 * has never been given — which surfaces as "no such column" from whichever screen
 * happens to ask first, with nothing to connect it to the cause.
 *
 * Checked once at start and said in one sentence instead.
 */
export function staleBuild(): string | null {
  if (SCHEMA_VERSION >= EXPECTED_SCHEMA_VERSION) return null
  return `This build carries database changes up to ${SCHEMA_VERSION}, but the code needs `
    + `${EXPECTED_SCHEMA_VERSION}. Close ShopOS and start it again — the new changes are on disk `
    + `but were not in the running copy.`
}
