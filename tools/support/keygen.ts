#!/usr/bin/env node
/**
 * Makes the vendor's support key: the pair data sent to support is sealed to.
 *
 *   npx tsx tools/support/keygen.ts [--out <file>]
 *
 * The private half is written to a file outside this repository (by default
 * `~/.shopos/support-key.json`) and never anywhere else: not the portal, not a
 * build, not git. Keep a copy offline, on paper or a USB stick in a drawer --
 * lose it and no data already sent can be opened; leak it and all of it can.
 *
 * The public half is printed, for `SHOPOS_SUPPORT_PUBKEY` in the build's `.env`.
 * It is safe anywhere.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { makeVendorKey, publicOf } from './src/sod.js'

const args = process.argv.slice(2)
const at = args.indexOf('--out')
const out = resolve(at >= 0 && args[at + 1] ? args[at + 1]! : join(homedir(), '.shopos', 'support-key.json'))

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
if (!relative(repo, out).startsWith('..')) {
  process.stderr.write(`Refusing to write the private key inside the repository (${out}).\n`)
  process.exit(1)
}
if (existsSync(out)) {
  process.stderr.write(`${out} already exists. A new key would leave everything sealed to the old one unopenable; move it first if you mean it.\n`)
  process.exit(1)
}

const key = makeVendorKey()
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ ...key, made: new Date().toISOString() }, null, 2), { mode: 0o600 })

process.stdout.write([
  `Private key written to ${out}`,
  'Copy it somewhere offline now. Nobody can open data sent to support without it.',
  '',
  'Put this line in apps/pos/src-tauri/.env (or the release secrets):',
  `SHOPOS_SUPPORT_PUBKEY=${publicOf(key)}`,
  '',
].join('\n'))
