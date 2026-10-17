#!/usr/bin/env -S npx tsx

import { existsSync, readFileSync } from 'node:fs'
import { generateKeypair } from './keys.js'
import { fromEnvironment } from './config.js'
import { issueLicence, currentLicence } from './licences.js'
import { isTier } from '@shopos/core/licence'
import { serve } from './server.js'
import { runDigest, DIGEST_CHECK_MS } from './health/runDigest.js'
import { sweepUploads } from './data/store.js'
import { setBoard } from './routes/switches.js'

/**
 * The portal from a terminal.
 *
 *   npx tsx apps/portal/src/cli.ts keygen
 *   npx tsx apps/portal/src/cli.ts issue --shop <id> --tier cloud --paid-through 2027-03-31
 *   npx tsx apps/portal/src/cli.ts show --shop <id>
 *   npx tsx apps/portal/src/cli.ts serve --port 8787
 *
 * ## Not `npm run portal --`, and this cost an evening
 *
 * From PowerShell, `npm run portal -- issue --shop <id> --tier cloud` reaches
 * this file as `issue <id> cloud`. npm parses every unrecognised `--name` as
 * one of its own config settings and drops it, keeping the value that followed
 * it — so `flag('shop')` returns null and the command dies claiming the
 * argument that was plainly typed is missing. The values are all still there,
 * in order, which is what makes it look like a bug in here.
 *
 * `npm run portal -- keygen --kid x` happens to survive from a POSIX shell,
 * which is worse than if it never worked: it teaches the wrong form.
 *
 * `keygen` is the first thing anybody runs and the only one that matters
 * before there is a paying shop: its public half goes in
 * `packages/core/src/config/licensing.ts` and its private half goes nowhere
 * near this repository.
 */

const args = process.argv.slice(2)
const command = args[0]

function flag(name: string): string | null {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? null : args[at + 1] ?? null
}

function die(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

switch (command) {
  case 'keygen': {
    const pair = await generateKeypair(flag('kid') ?? undefined)
    process.stdout.write([
      '',
      'A new licence signing key.',
      '',
      `  kid          ${pair.kid}`,
      '',
      'Public half — paste into packages/core/src/config/licensing.ts:',
      '',
      `  { kid: '${pair.kid}', publicKey: '${pair.publicKey}' },`,
      '',
      'Private half — SHOPOS_LICENCE_KEY in the portal\'s environment, and',
      'in two backups. It is not recoverable and it must not be committed:',
      '',
      `  ${pair.privateKey}`,
      '',
    ].join('\n'))
    break
  }

  case 'issue': {
    const portal = await fromEnvironment()
    if (portal.signingKey === null) die('SHOPOS_LICENCE_KEY is not set — run `keygen` first')

    const shop = flag('shop') ?? die('--shop is required')
    const tier = flag('tier') ?? 'single'
    if (!isTier(tier)) die(`--tier is single, cloud or branches, not "${tier}"`)

    const tills = Number(flag('tills') ?? '1')
    const result = await issueLicence(portal.db, portal.signingKey, {
      shopId: shop,
      tier,
      paidThrough: flag('paid-through'),
      tills,
      kid: portal.kid,
      issuedBy: 'cli',
    })

    if (!result.ok) die(`${result.code}: ${result.detail}`)
    process.stdout.write(`${result.licence.token}\n`)
    await portal.close()
    break
  }

  case 'show': {
    const portal = await fromEnvironment()
    const shop = flag('shop') ?? die('--shop is required')
    const licence = await currentLicence(portal.db, shop)
    process.stdout.write(
      licence === null
        ? `no licence issued to ${shop}\n`
        : `${JSON.stringify(licence, null, 2)}\n`,
    )
    await portal.close()
    break
  }

  case 'serve': {
    const portal = await fromEnvironment()
    const port = Number(flag('port') ?? '8787')
    await serve(portal, { port })
    process.stdout.write(
      `portal on http://127.0.0.1:${port} — ` +
      `otp via ${portal.channel.name}, ` +
      `${portal.signingKey === null ? 'no signing key' : `signing as ${portal.kid}`}, ` +
      `${portal.vendors?.size ?? 0} vendor phone(s), ` +
      `digest ${portal.digestBot === null ? 'off' : 'on'}\n`,
    )
    // The morning digest, asked about every few minutes; it goes once a day.
    // Data sent to support is deleted on its date on the same beat.
    setInterval(() => {
      void runDigest(portal.db, portal.digestBot).then((r) => {
        if (!r.sent && r.why === 'failed') process.stderr.write(`[portal] digest: ${r.error}\n`)
      })
      if (portal.filesDir) {
        void sweepUploads(portal.db, portal.filesDir, new Date())
          .catch((e: unknown) => process.stderr.write(`[portal] sweep: ${String(e)}\n`))
      }
    }, DIGEST_CHECK_MS).unref()
    break
  }

  case 'switches': {
    // A board made by tools/support/switches.ts, from a file or pasted.
    const given = args[1]
    if (!given) {
      process.stderr.write('switches <file or token>: a board from tools/support/switches.ts\n')
      process.exit(1)
    }
    const token = existsSync(given) ? readFileSync(given, 'utf8').trim() : given
    const portal = await fromEnvironment()
    const set = await setBoard(portal.db, token, 'cli', new Date())
    process.stdout.write(set.ok ? `board of ${set.issuedAt} is out; tills pick it up within half an hour\n` : `not set: ${set.detail}\n`)
    await portal.close()
    if (!set.ok) process.exit(1)
    break
  }

  case 'digest': {
    const portal = await fromEnvironment()
    const result = await runDigest(portal.db, portal.digestBot, { force: true })
    process.stdout.write(result.sent ? `${result.text}\n` : `not sent: ${result.why}${'error' in result ? ` (${result.error})` : ''}\n`)
    await portal.close()
    if (!result.sent) process.exit(1)
    break
  }

  default:
    process.stdout.write([
      'npx tsx apps/portal/src/cli.ts <command>',
      '',
      '  keygen [--kid <name>]                       a new signing keypair',
      '  issue --shop <id> [--tier <t>]              sign a licence',
      '        [--paid-through YYYY-MM-DD] [--tills n]',
      '  show --shop <id>                            the shop\'s current licence',
      '  serve [--port 8787]                         run the HTTP service',
      '  digest                                      send the morning digest now',
      '  switches <file|token>                       put out a switch board',
      '',
      'Run it directly, not through `npm run portal --`: npm swallows every',
      '--flag and passes only the values, so a correct command line arrives',
      'here missing the arguments it will then say are required.',
      '',
    ].join('\n'))
    if (command !== undefined) process.exit(1)
}
