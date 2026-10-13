#!/usr/bin/env node
import { startTill } from './till.js'
import { startControl } from './control.js'

/**
 * One till, in its own process, listening until it is killed.
 *
 * This is what Layer 2 runs: a container per till, on a real Docker network,
 * so that discovery over UDP broadcast and sync over TCP are exercised across
 * actual network namespaces rather than on loopback. It is also the quickest
 * way to put a second till in front of the real app by hand — start one of
 * these, pair the app with it, and watch what crosses.
 *
 * Deliberately the same `startTill` the in-process scenarios use. A separate
 * server implementation for containers would be a second protocol nobody reads,
 * and the first place the two would drift is the part Layer 2 exists to check.
 */

interface Args { [flag: string]: string | undefined }

function parse(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token?.startsWith('--')) {
      const next = argv[i + 1]
      args[token.slice(2)] = next && !next.startsWith('--') ? next : 'true'
      if (next && !next.startsWith('--')) i += 1
    }
  }
  return args
}

const USAGE = `virtual-till serve --data DIR --device ID --register PFX [--port N] [--label NAME] [--seed empty|shop]

  --data      where this till keeps its database
  --device    its device id; must differ from every other till in the shop
  --register  the counter prefix it bills on, 2-4 of A-Z0-9
  --port      0 for an ephemeral one (default 7803)
  --seed      'shop' sets up a new shop; 'empty' (default) waits to be paired
  --star      a shop's shape: the first till to let another in becomes the main
  --clock-offset  minutes this till's clock is ahead (negative: behind)
`

function offsetClock(minutes: number): () => number {
  if (!Number.isFinite(minutes)) {
    process.stderr.write('virtual-till: --clock-offset takes a number of minutes\n')
    process.exit(2)
  }
  return () => Date.now() + minutes * 60_000
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command !== 'serve') {
    process.stderr.write(USAGE)
    process.exit(command === undefined ? 1 : 2)
  }

  const args = parse(rest)
  const missing = ['data', 'device', 'register'].filter((k) => !args[k])
  if (missing.length > 0) {
    process.stderr.write(`virtual-till: missing --${missing.join(', --')}\n\n${USAGE}`)
    process.exit(2)
  }

  const till = await startTill({
    dataDir: args['data']!,
    deviceId: args['device']!,
    label: args['label'] ?? args['device']!,
    registerPrefix: args['register']!,
    port: Number(args['port'] ?? 7803),
    ...(args['advertise'] ? { advertisePort: Number(args['advertise']) } : {}),
    seed: args['seed'] === 'shop' ? 'shop' : 'empty',
    star: args['star'] === 'true',
    /* A machine whose clock is wrong, which a namespace cannot have: they all
       share the kernel's. The till reads this one instead. */
    ...(args['clock-offset'] ? { clock: offsetClock(Number(args['clock-offset'])) } : {}),
  })

  /* The stand-in for a person pressing buttons, for a till in a container that
     has nobody to press them. Only when asked for, and only ever on loopback —
     `control.ts` says why that is the single option rather than a default. */
  const control = args['control']
    ? await startControl(till, Number(args['control']))
    : null

  // One line, parseable, because `run.sh` reads the ports back out of it.
  process.stdout.write(`${JSON.stringify({
    ok: true, url: till.url, deviceId: till.deviceId, registerId: till.registerId,
    control: control?.port ?? null,
  })}\n`)

  /* Docker sends SIGTERM and waits ten seconds before SIGKILL. Closing the
     database rather than being killed with it open is what makes the next start
     a clean one instead of a WAL recovery. */
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void Promise.resolve(control?.stop())
        .then(() => till.stop())
        .then(() => process.exit(0))
    })
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`virtual-till: ${String(err)}\n`)
  process.exit(1)
})
