#!/usr/bin/env node
/**
 * The support workbench: a shop's database, looked at from the vendor's desk.
 *
 *   npx tsx tools/support/support.ts check <file>                 every check, as a page
 *   npx tsx tools/support/support.ts timeline <file> --doc <no>   everything that touched one document
 *   npx tsx tools/support/support.ts diff <file> <file>           why two tills disagree
 *
 * <file> is a `.sod` a till sent (opened with `--key`, default
 * `~/.shopos/support-key.json`), a folder `open.ts` made, or a `shop.db`.
 * Each is worked on as a copy, brought up to this code's schema first, and
 * the file given is never written to. `--json` prints what `check` found as
 * JSON, for a ticket.
 */
import { loadShop, type Loaded } from './src/load.js'
import { checkShop, render } from './src/check.js'
import { findDocument, timeline, renderTimeline } from './src/timeline.js'
import { diffShops, renderDiff } from './src/diff.js'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--') && args[i - 1] !== '--json'))
const [command, ...files] = positional
const key = flag('--key') ?? undefined

function heading(shop: Loaded, file: string): string {
  const m = shop.manifest
  return [
    `${file}`,
    m ? `  shop ${m.shopId}, till ${m.deviceId} on ${m.appVersion}, sent ${m.madeAt} by ${m.madeBy}`
      + `${m.anonymised ? ', customers left out' : ''}${m.note ? `\n  "${m.note}"` : ''}` : '',
    `  schema ${shop.schemaFrom}${shop.schemaTo !== shop.schemaFrom ? ` (brought up to ${shop.schemaTo} for these checks)` : ''}`,
    '',
  ].filter((l) => l !== '').join('\n')
}

async function main(): Promise<number> {
  switch (command) {
    case 'check': {
      if (!files[0]) break
      const shop = await loadShop(files[0], { key })
      try {
        const sections = await checkShop(shop.db)
        if (args.includes('--json')) process.stdout.write(`${JSON.stringify({ manifest: shop.manifest, sections }, null, 2)}\n`)
        else process.stdout.write(`${heading(shop, files[0])}\n\n${render(sections)}\n`)
        return sections.every((s) => s.ok) ? 0 : 2
      } finally {
        await shop.close()
      }
    }
    case 'timeline': {
      const ref = flag('--doc')
      if (!files[0] || !ref) break
      const shop = await loadShop(files[0], { key })
      try {
        const doc = await findDocument(shop.db, ref)
        if (doc === null) {
          process.stderr.write(`No document numbered or with the id ${ref} in this shop.\n`)
          return 1
        }
        process.stdout.write(`${renderTimeline(doc, await timeline(shop.db, doc))}\n`)
        return 0
      } finally {
        await shop.close()
      }
    }
    case 'diff': {
      if (!files[0] || !files[1]) break
      const a = await loadShop(files[0], { key })
      const b = await loadShop(files[1], { key })
      try {
        const found = await diffShops(a.db, b.db, ['the first', 'the second'])
        process.stdout.write(`${renderDiff(found)}\n`)
        return found.length === 0 ? 0 : 2
      } finally {
        await a.close()
        await b.close()
      }
    }
  }
  process.stdout.write([
    'npx tsx tools/support/support.ts <command>',
    '',
    '  check <file> [--json]               every check, as a page; exits 2 when something needs a look',
    '  timeline <file> --doc <number|id>   everything that touched one document, in order',
    '  diff <file> <file>                  every row two tills hold differently',
    '',
    '  <file>: a .sod (with --key, default ~/.shopos/support-key.json), a folder open.ts made, or a shop.db',
    '',
  ].join('\n'))
  return command === undefined ? 0 : 1
}

main().then((code) => process.exit(code), (err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
