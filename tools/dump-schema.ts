/**
 * Writes `docs/schema.md` from a database built by running every migration.
 *
 *   npm run schema:doc
 *
 * Nothing reads a shop's file: the document describes what the migrations
 * produce, which is the same on every till and contains nobody's data.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openMemoryDatabase } from '../packages/core/src/db/node-driver.js'
import { migrate } from '../packages/core/src/db/migrate.js'
import { MIGRATIONS } from '../packages/core/src/db/migrations.js'
import { describeSchema } from '../packages/core/src/db/describe.js'
import { renderSchemaDoc } from '../packages/core/src/db/schemaDoc.js'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'schema.md')

const db = openMemoryDatabase()
await migrate(db, MIGRATIONS)
const doc = renderSchemaDoc(await describeSchema(db))
await db.close()

writeFileSync(out, doc, 'utf8')
process.stdout.write(`${out}\n`)
