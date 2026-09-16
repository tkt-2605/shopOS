import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Migration } from './migrate.js'
import { EXPECTED_SCHEMA_VERSION } from './schemaVersion.js'
import { MIGRATION_FILES } from './migrationKinds.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', 'migrations')

/* The list lives in `migrationKinds.ts`, which reads nothing off disk and can
   therefore be imported by the webview as well as by this file. See the note
   there on why the classification has to be reachable from both. */
const FILES = MIGRATION_FILES

export const MIGRATIONS: Migration[] = FILES.map(([version, file]) => ({
  version,
  name: file,
  sql: readFileSync(join(migrationsDir, file), 'utf8'),
}))

/* Adding the file and adding it here are two steps and one gets forgotten. This
   is the third place that has to agree, so it checks rather than trusts. */
const highest = FILES[FILES.length - 1]?.[0] ?? 0
if (highest !== EXPECTED_SCHEMA_VERSION) {
  throw new Error(
    `migration list ends at ${highest} but the code expects ${EXPECTED_SCHEMA_VERSION}`,
  )
}
