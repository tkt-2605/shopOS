#!/usr/bin/env node
/**
 * Makes a repair pack for one shop: a signed, single-use fix the owner applies
 * from Settings -> Help -> Apply a fix from support.
 *
 *   npx tsx tools/support/pack.ts --shop <shop id> --ticket "142: counter held by a dead till"
 *       --repair free_counter:registerId=<id>
 *       [--repair reconcile:what=all] [--days 7] [--key ~/.shopos/repair-key.json] [--out fix.txt]
 *
 * Repairs, and what each needs:
 *   reconcile:what=all|stock|returned|fulfilled|loyalty|reversals
 *   retry_set_aside
 *   free_counter:registerId=<id>
 *   renumber_from:docType=bill,prefix=FC,fiscalYear=2627,next=43
 *   reset_peer_cursor:deviceId=<id>,from=<n>
 *
 * Find the ids with `support.ts check` or `timeline` on the shop's data. The
 * pack is text: send it by WhatsApp or as a file. It names the shop, so it
 * does nothing anywhere else, and ends after --days.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { makePack, parseRepairSpec, type RepairKey } from './src/repair.js'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const all = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []))

const shopId = flag('--shop')
const ticket = flag('--ticket')
const specs = all('--repair')
if (!shopId || !ticket || specs.length === 0) {
  process.stdout.write('npx tsx tools/support/pack.ts --shop <id> --ticket "<case>" --repair <kind:field=value,...> [...]\n')
  process.exit(1)
}

const keyPath = resolve(flag('--key') ?? join(homedir(), '.shopos', 'repair-key.json'))
if (!existsSync(keyPath)) {
  process.stderr.write(`No repair key at ${keyPath}. Make one with: npx tsx tools/support/keygen.ts --repair\n`)
  process.exit(1)
}
const key = JSON.parse(readFileSync(keyPath, 'utf8')) as RepairKey

try {
  const { raw, pack } = makePack(key, {
    shopId, ticket, repairs: specs.map(parseRepairSpec), days: Number(flag('--days') ?? '7'),
  })
  const out = flag('--out')
  if (out) writeFileSync(out, `${raw}\n`)
  process.stdout.write([
    `Pack ${pack.id} for shop ${pack.shopId}, until ${pack.expiresAt}:`,
    ...pack.repairs.map((r) => `  ${JSON.stringify(r)}`),
    '',
    out ? `Written to ${out}.` : raw,
    '',
  ].join('\n'))
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
}
