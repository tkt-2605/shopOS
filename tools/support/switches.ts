#!/usr/bin/env node
/**
 * Makes a switch board: features off at some shops or all, without a release.
 *
 *   npx tsx tools/support/switches.ts --why "0.3.0 stalls on slow lines" \
 *       --off startup_sync [--off stock_check:shops=0192f4a1,until=2026-10-25] [--out board.txt]
 *   npx tsx tools/support/switches.ts --all-on        a board that turns everything back on
 *
 * Features that can be switched: startup_sync, stock_check, daily_reports,
 * needs_attention_banner, online_orders. Nothing that takes money can be.
 *
 * Signed with the repair key (`~/.shopos/repair-key.json`, or --key). Put it
 * out with `npx tsx apps/portal/src/cli.ts switches board.txt` on the portal;
 * tills pick it up within half an hour. A board replaces the last one whole:
 * list everything that should still be off.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { SWITCHES } from '@shopos/core'
import { makeBoard, parseOffSpec, type RepairKey } from './src/repair.js'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const offs = args.flatMap((a, i) => (a === '--off' && args[i + 1] ? [args[i + 1]!] : []))
const allOn = args.includes('--all-on')
const why = flag('--why')

if ((offs.length === 0 && !allOn) || (offs.length > 0 && !why)) {
  process.stdout.write([
    'npx tsx tools/support/switches.ts --why "<reason>" --off <feature>[:shops=<id>,<id>,until=<date>] ...',
    'npx tsx tools/support/switches.ts --all-on',
    '',
    ...Object.entries(SWITCHES).map(([k, v]) => `  ${k.padEnd(24)} ${v}`),
    '',
  ].join('\n'))
  process.exit(1)
}

const keyPath = resolve(flag('--key') ?? join(homedir(), '.shopos', 'repair-key.json'))
if (!existsSync(keyPath)) {
  process.stderr.write(`No repair key at ${keyPath}. Make one with: npx tsx tools/support/keygen.ts --repair\n`)
  process.exit(1)
}
const key = JSON.parse(readFileSync(keyPath, 'utf8')) as RepairKey

try {
  const board = await makeBoard(key, offs.map((o) => parseOffSpec(o, why ?? '')))
  const out = flag('--out')
  if (out) writeFileSync(out, `${board}\n`)
  process.stdout.write(`${allOn ? 'Everything on.' : `Off: ${offs.join('; ')}`}\n${out ? `Written to ${out}.` : board}\n`)
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
}
