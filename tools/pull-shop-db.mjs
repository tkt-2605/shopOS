#!/usr/bin/env node
/**
 * Takes a safe copy of a real shop's database, for tests to run against.
 *
 * Every phase spec ends its verification with some form of "against the owner's
 * real database, not the fixture". That instruction has had no way to be
 * followed, because there was no way to get the database off the machine it
 * lives on — and the fixture has already been caught lying: it agreed that
 * `customers.state_code` was '33' for every row, which was a number nobody had
 * ever typed, and the GST bug that hid behind it survived a thousand tests.
 *
 * So this is the first tool, before the code any of it verifies.
 *
 * **VACUUM INTO, never a file copy.** Under WAL the main database file is stale
 * by whatever the write-ahead log has not checkpointed yet. Copying `shop.db`
 * on its own gives a database that is missing the most recent bills — which is
 * the worst possible failure here, because the copy still opens, still passes
 * `integrity_check`, and quietly disagrees with the shop about what was sold
 * today. Copying all three files gives a torn snapshot instead. VACUUM INTO
 * asks SQLite for one consistent database, and it is safe to run while the till
 * is open: WAL allows a reader alongside a writer.
 *
 * Usage:
 *   node tools/pull-shop-db.mjs                    # from this machine's ShopOS
 *   node tools/pull-shop-db.mjs --from <path>      # from a copy you were sent
 *   node tools/pull-shop-db.mjs --out <path>       # somewhere other than the default
 */

import { mkdirSync, existsSync, statSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

/** Gitignored, and named so that a stray `git add -f` still reads as a warning. */
const DEFAULT_OUT = join(repo, 'tools', 'fixtures', 'real-shop.db')

/**
 * Where Tauri puts `app_data_dir()` on Windows for this bundle identifier.
 *
 * Read from `tauri.conf.json` rather than written out, so that changing the
 * identifier does not leave this tool silently pointing at a folder that no
 * longer exists and reporting "no database found" as though the shop had none.
 */
function defaultSource() {
  const conf = JSON.parse(
    readFileSync(join(repo, 'apps', 'pos', 'src-tauri', 'tauri.conf.json'), 'utf8'),
  )
  const roaming = process.env['APPDATA']
  if (!roaming) return null
  return join(roaming, conf.identifier, 'shop.db')
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1] ?? null
}

function fail(message) {
  console.error(`pull-shop-db: ${message}`)
  process.exit(1)
}

const source = arg('--from') ?? defaultSource()
const out = arg('--out') ?? DEFAULT_OUT

if (!source) fail('could not work out where ShopOS keeps its data; pass --from <path>')
if (!existsSync(source)) {
  fail(
    `no database at ${source}\n`
    + '  If ShopOS runs on another machine, copy its whole data folder across and\n'
    + '  pass --from, or restore one of its backup zips and point at that.',
  )
}

mkdirSync(dirname(out), { recursive: true })

// VACUUM INTO refuses a target that already exists, which would otherwise make
// a leftover from a previous run break every future pull rather than this one.
rmSync(out, { force: true })

const db = new Database(source, { readonly: true, fileMustExist: true })

try {
  // `exec`, not `prepare().run()`: better-sqlite3 classifies VACUUM as a write
  // and refuses it on a readonly handle, though it writes only to the target.
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`)
} catch (err) {
  fail(`could not copy the database: ${err.message}`)
} finally {
  db.close()
}

/**
 * What came out, said in the shop's own terms.
 *
 * A pull that produced an empty or half-written database must not look like a
 * pull that worked. Every line below is something a person can sanity-check
 * against the till's own screens: the bill count against the Bills page, the
 * last bill date against yesterday's trade.
 */
const copy = new Database(out, { readonly: true, fileMustExist: true })

const integrity = copy.prepare('PRAGMA integrity_check').get()
const schema = copy.prepare('PRAGMA user_version').get()['user_version']

function count(table) {
  try {
    return copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  } catch {
    return null // A database old enough not to have the table yet.
  }
}

const bills = count('bills')
const lastBill = (() => {
  try {
    return copy.prepare(
      'SELECT MAX(posting_date) AS d FROM bills WHERE docstatus = 1',
    ).get().d
  } catch {
    return null
  }
})()

// Every count is taken before the handle closes. Read afterwards, `count`
// swallows the "database is closed" error as "the table is not there yet" and
// prints an em dash — a pull of an empty database and a pull of a healthy one
// would look identical, which is the one thing this summary exists to prevent.
const products = count('products')
const customers = count('customers')

copy.close()

const size = (statSync(out).size / 1024 / 1024).toFixed(1)
const ok = integrity['integrity_check'] === 'ok'

console.log(`from      ${source}`)
console.log(`to        ${out}  (${size} MB)`)
console.log(`schema    ${schema}`)
console.log(`integrity ${integrity['integrity_check']}`)
console.log(`bills     ${bills ?? '—'}${lastBill ? `, last submitted ${lastBill}` : ''}`)
console.log(`products  ${products ?? '—'}   customers ${customers ?? '—'}`)
console.log('')
console.log('This file holds a real shop\'s trade. It is gitignored; keep it that way.')

if (!ok) {
  console.error('\nThe copy did not pass integrity_check. Do not verify anything against it.')
  process.exit(1)
}
