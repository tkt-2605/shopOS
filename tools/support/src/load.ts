import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { migrate, currentVersion, type SqlDriver } from '@shopos/core'
import { openDatabase } from '@shopos/core/node'
import { MIGRATIONS } from '@shopos/core/migrations'
import { open, type Manifest, type VendorKey } from './sod.js'

/*
 * A shop's database, ready to look at: from a sealed file a till sent, a
 * folder `open.ts` opened, or a `shop.db` copied off a machine.
 *
 * Always a copy in a folder of its own, and always brought up to this
 * code's schema first, so every check runs the code the shop runs now. The
 * file given is never written to: a support case that changed the evidence
 * has lost it.
 */

export interface Loaded {
  db: SqlDriver
  /** The working copy. */
  path: string
  manifest: Manifest | null
  schemaFrom: number
  schemaTo: number
  close: () => Promise<void>
}

export const DEFAULT_KEY = join(homedir(), '.shopos', 'support-key.json')

export async function loadShop(input: string, opts: { key?: string | undefined } = {}): Promise<Loaded> {
  if (!existsSync(input)) throw new Error(`There is nothing at ${input}.`)
  const work = mkdtempSync(join(tmpdir(), 'shopos-support-'))
  const path = join(work, 'shop.db')
  let manifest: Manifest | null = null

  if (input.toLowerCase().endsWith('.sod')) {
    const keyPath = opts.key ?? DEFAULT_KEY
    if (!existsSync(keyPath)) throw new Error(`No support key at ${keyPath}. It is the file tools/support/keygen.ts made.`)
    const opened = open(readFileSync(input), JSON.parse(readFileSync(keyPath, 'utf8')) as VendorKey)
    manifest = opened.manifest
    writeFileSync(path, opened.db)
  } else {
    const dir = statSync(input).isDirectory()
    const db = dir ? join(input, 'shop.db') : input
    if (!existsSync(db)) throw new Error(`No shop.db in ${input}.`)
    copyFileSync(db, path)
    // A copy taken off a running till may still have its last writes in the WAL.
    for (const side of ['-wal', '-shm']) if (existsSync(db + side)) copyFileSync(db + side, path + side)
    const m = join(dir ? input : join(db, '..'), 'manifest.json')
    if (existsSync(m)) manifest = JSON.parse(readFileSync(m, 'utf8')) as Manifest
  }

  const db = openDatabase(path)
  const schemaFrom = await currentVersion(db)
  await migrate(db, MIGRATIONS)
  const schemaTo = await currentVersion(db)
  return {
    db, path, manifest, schemaFrom, schemaTo,
    close: async () => { await db.close(); rmSync(work, { recursive: true, force: true }) },
  }
}
