#!/usr/bin/env -S npx tsx

import { generateKeypair } from './keys.js'
import { fromEnvironment } from './config.js'
import { issueLicence, currentLicence } from './licences.js'
import { isTier } from '@shopos/core/licence'
import { serve } from './server.js'

/**
 * The portal from a terminal.
 *
 *   npm run portal -- keygen
 *   npm run portal -- issue --shop <id> --tier cloud --paid-through 2027-03-31
 *   npm run portal -- show --shop <id>
 *   npm run portal -- serve --port 8787
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
      `${portal.signingKey === null ? 'no signing key' : `signing as ${portal.kid}`}\n`,
    )
    break
  }

  default:
    process.stdout.write([
      'portal <command>',
      '',
      '  keygen [--kid <name>]                       a new signing keypair',
      '  issue --shop <id> [--tier <t>]              sign a licence',
      '        [--paid-through YYYY-MM-DD] [--tills n]',
      '  show --shop <id>                            the shop\'s current licence',
      '  serve [--port 8787]                         run the HTTP service',
      '',
    ].join('\n'))
    if (command !== undefined) process.exit(1)
}
