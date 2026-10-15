#!/usr/bin/env node
/**
 * Opens a shop's data, sent to support from a till or downloaded from the console.
 *
 *   npx tsx tools/support/open.ts <file.sod> [--key <file>] [--out <folder>]
 *
 * Writes `shop.db` and `manifest.json` into a folder of its own (by default
 * beside the file, named after it) and says what the manifest says. The key
 * is `~/.shopos/support-key.json` unless `--key` names another.
 *
 * What comes out is a real shop's books: keep it off shared folders, and
 * delete it when the case is closed. The portal deletes its copy after thirty
 * days; this one is yours to delete.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { open, type VendorKey } from './src/sod.js'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')))

if (!file) {
  process.stdout.write('npx tsx tools/support/open.ts <file.sod> [--key <file>] [--out <folder>]\n')
  process.exit(1)
}

const keyPath = resolve(flag('--key') ?? join(homedir(), '.shopos', 'support-key.json'))
if (!existsSync(keyPath)) {
  process.stderr.write(`No support key at ${keyPath}. It is the file tools/support/keygen.ts made.\n`)
  process.exit(1)
}
const key = JSON.parse(readFileSync(keyPath, 'utf8')) as VendorKey

const opened = open(readFileSync(resolve(file)), key)
const out = resolve(flag('--out') ?? join(dirname(resolve(file)), basename(file).replace(/\.sod$/i, '')))
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'shop.db'), opened.db)
writeFileSync(join(out, 'manifest.json'), JSON.stringify(opened.manifest, null, 2))

const m = opened.manifest
process.stdout.write([
  `Opened into ${out}`,
  `  shop      ${m.shopId}`,
  `  till      ${m.deviceId}, version ${m.appVersion}`,
  `  made      ${m.madeAt} by ${m.madeBy}`,
  `  customers ${m.anonymised ? `left out (${m.customersHidden} replaced)` : 'included'}`,
  m.note ? `  note      ${m.note}` : '',
  '',
].filter((l) => l !== '').join('\n') + '\n')
