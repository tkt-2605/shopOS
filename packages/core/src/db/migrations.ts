import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Migration } from './migrate.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', 'migrations')

const FILES: ReadonlyArray<readonly [number, string]> = [
  [1, '001_initial.sql'],
  [2, '002_stock_value.sql'],
  [3, '003_margin_guards.sql'],
  [4, '004_attachments.sql'],
]

export const MIGRATIONS: Migration[] = FILES.map(([version, file]) => ({
  version,
  name: file,
  sql: readFileSync(join(migrationsDir, file), 'utf8'),
}))
