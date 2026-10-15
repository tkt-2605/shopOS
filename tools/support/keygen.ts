#!/usr/bin/env node
/**
 * Makes one of the vendor's two support keys.
 *
 *   npx tsx tools/support/keygen.ts [--out <file>]            the data key
 *   npx tsx tools/support/keygen.ts --repair [--out <file>]   the repair key
 *
 * The data key (X25519) is what a shop's data sent to support is sealed to;
 * its public half goes in `SHOPOS_SUPPORT_PUBKEY`. The repair key (Ed25519)
 * signs repair packs; its public half goes in `config/repairs.ts`. Two keys,
 * so that losing control of one does not hand over the other.
 *
 * The private half is written outside this repository -- by default
 * `~/.shopos/support-key.json` or `~/.shopos/repair-key.json` -- and never
 * anywhere else: not the portal, not a build, not git. Keep a copy offline.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { makeVendorKey, publicOf } from './src/sod.js'
import { makeRepairKey, publicEntry } from './src/repair.js'

const args = process.argv.slice(2)
const repair = args.includes('--repair')
const at = args.indexOf('--out')
const out = resolve(at >= 0 && args[at + 1] ? args[at + 1]! : join(homedir(), '.shopos', repair ? 'repair-key.json' : 'support-key.json'))

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
if (!relative(repo, out).startsWith('..')) {
  process.stderr.write(`Refusing to write the private key inside the repository (${out}).\n`)
  process.exit(1)
}
if (existsSync(out)) {
  process.stderr.write(`${out} already exists. A new key would orphan everything made with the old one; move it first if you mean it.\n`)
  process.exit(1)
}

mkdirSync(dirname(out), { recursive: true })
const made = new Date().toISOString()
if (repair) {
  const key = makeRepairKey(`shopos-repair-${made.slice(0, 4)}`)
  writeFileSync(out, JSON.stringify({ ...key, made }, null, 2), { mode: 0o600 })
  const entry = publicEntry(key)
  process.stdout.write([
    `Private repair key written to ${out}`,
    'Copy it somewhere offline now. Anyone holding it can change shops\' records.',
    '',
    'Put this in REPAIR_KEYS in packages/core/src/config/repairs.ts:',
    `  { kid: '${entry.kid}', publicKey: '${entry.publicKey}' },`,
    '',
  ].join('\n'))
} else {
  const key = makeVendorKey()
  writeFileSync(out, JSON.stringify({ ...key, made }, null, 2), { mode: 0o600 })
  process.stdout.write([
    `Private key written to ${out}`,
    'Copy it somewhere offline now. Nobody can open data sent to support without it.',
    '',
    'Put this line in apps/pos/src-tauri/.env (or the release secrets):',
    `SHOPOS_SUPPORT_PUBKEY=${publicOf(key)}`,
    '',
  ].join('\n'))
}
