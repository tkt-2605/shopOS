import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  migrate, bootstrap, createRegister, handleSyncRequest, offerPairing, withdrawPairing,
  pairWith, pairedPeers, httpTransport, syncWith, newId, LISTEN_PORT_HEADER,
  type SqlDriver, type SyncTransport, type SyncResult,
} from '@shopos/core'
import { openDatabase } from '@shopos/core/node'
import { MIGRATIONS } from '@shopos/core/migrations'
import { asTill, installTillContext, type TillContext } from './context.js'

/**
 * A ShopOS till with no window.
 *
 * Everything below the screen: the same migrations, the same `handleSyncRequest`
 * the Rust listener calls, the same `httpTransport` the webview uses, over a
 * real socket. What it is missing is React and Tauri, and neither of those has
 * ever been where a sync bug lived.
 *
 * It exists because the host-till bug survived 1047 tests. Every one of those
 * tests let the joiner initiate, because that is the shape the app's screens
 * make easy, and so the host's outbound path was never once exercised. A till
 * you can start twice in a test, point at each other, and drive from *either*
 * end is the only way that class of bug gets caught — and it has to be a
 * package rather than a test helper, because Phase 6's cloud peer is this same
 * headless till with a different driver behind it.
 *
 * Nothing here stubs anything. Where a scenario needs a network to misbehave it
 * wraps the transport (`faults.ts`); the till itself has no idea.
 */

export interface TillOptions {
  /** Its own SQLite file and attachments live here. */
  dataDir: string
  deviceId: string
  label: string
  /** Two to four characters, `A-Z0-9`. The counter this till bills on. */
  registerPrefix: string
  /** 0 asks the OS for a free one, which is what a test wants. */
  port?: number
  /**
   * The port other tills should come back on, when it is not the one this
   * process listens on.
   *
   * In a container the Node till listens on loopback and `shopos-net` answers
   * the outside world on 7801. Advertising the till's own port would tell a
   * peer to knock on a door only this container can open — and the peer, being
   * on another machine, would knock on *its own* 7803 instead and get a very
   * confusing `UNKNOWN_PEER`. Layer 2 found exactly that.
   */
  advertisePort?: number
  /** Skewed against the other till's, to prove the merge rule and the ±5 min window. */
  clock?: () => number
  /** Wraps the outbound transport. See `faults.ts`. */
  transport?: (inner: SyncTransport) => SyncTransport
  /**
   * `'shop'` is a till that was set up — it has the shop, so it can be paired
   * *with*. `'empty'` is a till that has been installed and nothing else, which
   * is what a second till in a real shop actually is: migrated, holding
   * nothing, and deliberately not bootstrapped, because a till that sets itself
   * up has created a *second shop* and no merge rule can reconcile that.
   */
  seed?: 'empty' | 'shop'
}

/** What a round did, including the case where the peer never answered. */
export type TillSyncResult =
  | SyncResult
  | { ok: false; code: 'UNREACHABLE'; error: string }
  /** Paired, and not this till's to dial. See `syncWithPeer`. */
  | { ok: false; code: 'CANNOT_DIAL'; error: string }

export interface Till {
  readonly db: SqlDriver
  readonly url: string
  /** The port it answers on, told to every till it contacts. */
  readonly port: number
  readonly deviceId: string
  readonly label: string
  /** Null until this till has a counter of its own — see `claimRegister`. */
  readonly registerId: string | null

  /** Runs `fn` as this till: its device id, its counter, its clock. */
  as<T>(fn: () => Promise<T>): Promise<T>

  /** The typed-code dance, in the direction a shop does it: this till joins `other`. */
  pairWith(other: Till): Promise<void>

  /**
   * **This** till initiates. The whole point of the package.
   *
   * Never throws. `syncWith` throws when a peer cannot be reached at all and
   * returns `{ok:false}` when it was reached and refused — a real distinction,
   * and the app's sync loop is what turns the first into a backoff. The bench
   * has to model the layer a shop actually experiences, so the throw is caught
   * here and reported as `UNREACHABLE`.
   */
  sync(other: Till): Promise<TillSyncResult>

  /**
   * The same round, addressed by device id rather than by a `Till` object.
   *
   * Layer 2 needs this: the two tills are in different containers, so the side
   * initiating has no handle on the other — only the peer row it wrote when
   * they paired. That row is also all the real app has.
   */
  syncWithPeer(deviceId: string): Promise<TillSyncResult>

  /** One submitted bill, so a sync has something to carry. */
  writeBill(docNo: string, total?: number): Promise<string>

  /** Takes a counter of its own, after it has the shop. Idempotent. */
  claimRegister(): Promise<string>

  /**
   * Moves this till to a counter that already exists — what a shopkeeper does
   * after a `SAME_REGISTER` refusal. Separate from `claimRegister` because that
   * one creates, and the recovery path must not create a third counter.
   */
  useRegister(id: string): Promise<void>

  stop(): Promise<void>
}

export async function startTill(opts: TillOptions): Promise<Till> {
  installTillContext()

  mkdirSync(opts.dataDir, { recursive: true })
  const db = openDatabase(join(opts.dataDir, 'shop.db'))

  const context: TillContext = {
    deviceId: opts.deviceId,
    registerId: null,
    clock: opts.clock ?? (() => Date.now()),
  }

  let registerId: string | null = null
  let adminId = ''

  await asTill(context, async () => {
    await migrate(db, MIGRATIONS)

    if (opts.seed === 'shop') {
      const seed = await bootstrap(db, { shopName: 'Bench Shop' })
      adminId = newId()
      const now = new Date().toISOString()
      await db.execute(
        `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
         VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
        [adminId, seed.roleIds['Admin']!, now, now],
      )
      registerId = await makeRegister(db, opts.registerPrefix, opts.label, adminId)
      context.registerId = registerId
    }
  })

  /**
   * The listener.
   *
   * Every request is handled inside *this* till's context, so a request
   * arriving from the other till cannot be answered with the other till's
   * identity or counter. That is not hypothetical: `/hello` answers with
   * `registerId`, and the `SAME_REGISTER` refusal is computed from it.
   */
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      void asTill(context, async () => {
        try {
          const advertised = Number(req.headers[LISTEN_PORT_HEADER])
          const answer = await handleSyncRequest(db, {
            path: req.url ?? '/',
            body,
            auth: (req.headers['x-shopos-auth'] as string | undefined) ?? null,
            // What `sync_server.rs` must also supply: the socket's own view of
            // who called, and the port they say they answer on.
            remoteAddress: callerAddress(req),
            listenPort: Number.isFinite(advertised) ? advertised : null,
          })
          send(res, answer.status, answer.body)
        } catch (err) {
          send(res, 500, JSON.stringify({ code: 'SERVER_ERROR', message: String(err) }))
        }
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  /* What we tell other tills to come back on. The same port in-process, and
     `shopos-net`'s port in a container. */
  const advertise = opts.advertisePort ?? port

  const till: Till = {
    db,
    url,
    port: advertise,
    deviceId: opts.deviceId,
    label: opts.label,
    get registerId() { return registerId },

    as<T>(fn: () => Promise<T>): Promise<T> {
      return asTill(context, fn)
    },

    /**
     * `other` offers a code, this till types it in.
     *
     * Both directions are recorded: the offering till writes a `sync_peers` row
     * in `handlePair`, this one writes its own in `pairWith`. A test that only
     * checked its own side would not notice the host's row missing — which is
     * the shape of the bug that made the host unable to initiate.
     */
    async pairWith(other: Till): Promise<void> {
      const code = await other.as(async () => offerPairing())
      try {
        await asTill(context, () =>
          pairWith(db, other.url, code, opts.label, fetch, { listenPort: advertise }))
      } finally {
        await other.as(async () => { withdrawPairing() })
      }
    },

    async sync(other: Till): Promise<TillSyncResult> {
      return till.syncWithPeer(other.deviceId)
    },

    async syncWithPeer(peerDeviceId: string): Promise<TillSyncResult> {
      return asTill(context, async () => {
        const peer = (await pairedPeers(db)).find((p) => p.deviceId === peerDeviceId)
        if (!peer) {
          /* Paired, but not dialable — a peer whose `reach` is `none` is one
             this till must never knock on, and `pairedPeers` leaves it out for
             exactly that reason. It is not an error and it is not unreachable:
             it is a peer that does the asking, which is a phone and, from
             behind a shop's NAT, the cloud. Told apart from a till nobody has
             paired with at all, which really is a mistake in a scenario. */
          const [known] = await db.query<{ device_id: string }>(
            `SELECT device_id FROM sync_peers WHERE device_id = ?`, [peerDeviceId],
          )
          if (known !== undefined) {
            return { ok: false as const, code: 'CANNOT_DIAL' as const, error: 'that till does not answer' }
          }
          throw new Error(`${opts.label} has not paired with ${peerDeviceId}; pair first`)
        }
        const inner = httpTransport(peer, fetch, { listenPort: advertise })
        const transport = opts.transport ? opts.transport(inner) : inner
        try {
          return await syncWith(db, transport, registerId)
        } catch (err) {
          return { ok: false as const, code: 'UNREACHABLE' as const, error: String(err) }
        }
      })
    },

    async writeBill(docNo: string, total = 10000): Promise<string> {
      return asTill(context, async () => {
        const id = await till.claimRegister()
        const billId = newId()
        const now = new Date().toISOString()
        const user = await db.get<{ id: string }>(`SELECT id FROM users LIMIT 1`)
        if (!user) throw new Error('this till has no user to bill as; sync first')
        await db.execute(
          `INSERT INTO bills
             (id, doc_no, register_id, posting_date, docstatus,
              subtotal, taxable_total, grand_total, paid_total,
              created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
          [billId, docNo, id, now.slice(0, 10), total, total, total, total,
           user.id, now, now],
        )
        return billId
      })
    },

    async claimRegister(): Promise<string> {
      if (registerId) return registerId
      return asTill(context, async () => {
        if (adminId === '') {
          const admin = await db.get<{ id: string }>(`SELECT id FROM users LIMIT 1`)
          adminId = admin?.id ?? newId()
        }
        registerId = await makeRegister(db, opts.registerPrefix, opts.label, adminId)
        context.registerId = registerId
        return registerId
      })
    },

    async useRegister(id: string): Promise<void> {
      registerId = id
      context.registerId = id
    },

    async stop(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await db.close()
    },
  }

  return till
}

/**
 * The counter this till bills on.
 *
 * `PREFIX_TAKEN` is returned, not thrown: two tills asking for `MR` is a real
 * shop's mistake, and `same-register.test.ts` needs the second one to end up
 * *sharing* the counter so that `syncWith`'s `SAME_REGISTER` refusal is the
 * thing being proved. Refusing here instead would mean the scenario never
 * reaches the code it is about.
 */
async function makeRegister(
  db: SqlDriver, prefix: string, name: string, actorId: string,
): Promise<string> {
  const result = await createRegister(db, { name, prefix, actorId })
  if (result.ok) return result.registerId

  if (result.code === 'PREFIX_TAKEN' || result.code === 'NAME_TAKEN') {
    const existing = await db.get<{ id: string }>(
      `SELECT id FROM registers WHERE prefix = ? OR name = ? LIMIT 1`, [prefix, name],
    )
    if (existing) return existing.id
  }
  throw new Error(`could not take counter ${prefix}: ${result.code}`)
}

/** Removes a till's folder. For a test that wants the next run to start clean. */
export function wipe(dataDir: string): void {
  rmSync(dataDir, { recursive: true, force: true })
}

/**
 * A reply with its length on it, never chunked.
 *
 * Node adds `Transfer-Encoding: chunked` to any response that does not declare
 * a length, and that is invisible to `fetch`, which unchunks it — so Layer 1
 * never saw it. `shopos-net` does not: it reads the socket and takes what
 * follows the blank line as the body, so a chunked reply arrived as
 * `d7
{"secret":...` and pairing failed with a JSON parse error inside the
 * container and nowhere else.
 *
 * `sync_server.rs` has always written `content-length`. This makes the Node
 * till answer the same way, which is what it should have been doing anyway:
 * the four responses are small JSON documents of known size.
 */
function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Who called, as far as this till can tell.
 *
 * Normally the socket, because a header is whatever the caller wants it to be.
 * The exception is a request arriving from **loopback**, which in a container
 * means it was forwarded by the `shopos-net` beside us: that process holds the
 * only socket to the real caller, so it is the only thing that knows the
 * address, and it passes it on in `x-shopos-remote`.
 *
 * Trusting the header only from loopback is the whole of the rule. Anything
 * reaching this port from off-machine is talking to us directly and its own
 * socket is the truth; anything on loopback is our own forwarder. Without the
 * exception the till records every peer as `127.0.0.1` and then syncs with
 * itself, which Layer 2 caught and Layer 1 never could.
 */
function callerAddress(req: IncomingMessage): string | null {
  const socket = req.socket.remoteAddress ?? null
  const loopback = socket === '127.0.0.1' || socket === '::1' || socket === '::ffff:127.0.0.1'
  if (!loopback) return socket

  const forwarded = req.headers['x-shopos-remote']
  const claimed = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return claimed?.trim() || socket
}
