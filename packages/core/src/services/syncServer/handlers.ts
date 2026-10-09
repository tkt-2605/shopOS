import { eq, and, lt, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { MIN_PEER_SCHEMA_VERSION } from '../../db/migrationKinds.js'
import type { ChangeBatch } from '../../domain/replicaShape.js'
import { applyBatch, changedHere, collectChanges } from '../sync.js'
import {
  constantTimeEquals, signReply, verify, pairingKey, agreeSecret, isPairingPublicKey, isKeyCommitment,
  codeProof, codeConfirmation,
} from '../syncAuth.js'
import { clock } from '../../clock.js'
import { askingToJoin, letThemIn, offered, pollingAJoin, withdrawPairing } from './pairing.js'
import { mayLetIn } from '../sync/layout.js'
import { handleHello } from './hello.js'
import { handleCopy } from './copy.js'
import {
  type SyncRequest, type SyncResponse, type SyncServerOptions, ok, parse, peerAddressFrom, refuse,
} from './wire.js'

/**
 * What the answering side needs told rather than looked up.
 *
 * Only the licence keys, and only so that a test can pair two tills. The build
 * ships one real public key and no test can mint a token for it, so without
 * this seam every sync test would have to carry the production *private* key —
 * which is the one thing that must never be in this repository.
 */
export async function handleSyncRequest(
  db: SqlDriver,
  request: SyncRequest,
  now = clock.now(),
  opts: SyncServerOptions = {},
): Promise<SyncResponse> {
  if (request.path === '/pair') return handlePair(db, request, now, opts)

  const auth = await verify(
    request.auth, request.path, request.body,
    async (id) => {
      const [row] = await q(db)
        .select({ secret: schema.syncPeers.secret })
        .from(schema.syncPeers)
        .where(eq(schema.syncPeers.deviceId, id))
      return row?.secret ?? null
    },
    now,
  )
  if (!auth.ok) return refuse(401, auth.code)

  /* On every accepted request, not only on pairing. A till moves desks, the
     router hands out a new lease overnight, the shop swaps the switch — and
     the address recorded the day they paired stops working, with nothing to
     re-record it. The request that just authenticated is proof of where that
     till is *now*, and it is the cheapest possible place to learn it.

     Only after `auth.ok`, so an unauthenticated caller cannot move a peer's
     address and make the shop's next sync dial them instead. */
  const seenAt = peerAddressFrom(request)
  if (seenAt !== null) {
    /* `IS NOT` rather than `<>`, because the column is nullable and a peer
       recorded without an address has NULL in it -- which `<>` answers NULL
       for, and the row is never updated. */
    await q(db).update(schema.syncPeers)
      .set({ address: seenAt })
      .where(and(
        eq(schema.syncPeers.deviceId, auth.deviceId),
        sql`${schema.syncPeers.address} IS NOT ${seenAt}`,
      ))
  }

  return sealed(await route(db, request, auth.deviceId, opts), auth.secret, auth.nonce)
}

async function route(
  db: SqlDriver, request: SyncRequest, them: string, opts: SyncServerOptions,
): Promise<SyncResponse> {
  switch (request.path) {
    case '/hello': return handleHello(db, them, request)
    case '/fetch': return handleFetch(db, request, them)
    case '/offer': return handleOffer(db, request, them)
    case '/copy': return handleCopy(db, them, opts)
    default: return refuse(404, 'NO_SUCH_REQUEST')
  }
}

/**
 * An answer to a request that proved who sent it, signed back.
 *
 * The status stays where it is -- the transport reads it -- and the body is
 * wrapped with the signature `syncClient` checks before it believes a word.
 * Refusals before the request authenticated are left unsigned: there is no
 * shared secret to sign them with, and a forged refusal only stops a round.
 */
async function sealed(answer: SyncResponse, secret: string, nonce: string): Promise<SyncResponse> {
  const mac = await signReply(secret, nonce, answer.status, answer.body)
  return { status: answer.status, body: JSON.stringify({ reply: answer.body, mac }) }
}

/**
 * Redeeming a code for a shared secret.
 *
 * The only request without a signature, because it is the one that agrees what
 * the signature will be made with. Everything that makes a short typed code safe
 * is here: it lives for minutes, it is compared without leaking how nearly right
 * a guess was, and **any attempt withdraws it** — right or wrong.
 *
 * Burning the code on a wrong guess rather than allowing retries is what makes
 * eight characters enough. Guessing becomes a matter of persuading a person to
 * read a fresh code out each time, which is not an attack on software.
 */
async function handlePair(
  db: SqlDriver,
  request: SyncRequest,
  now: number,
  opts: SyncServerOptions,
): Promise<SyncResponse> {
  const asked = parse<{
    code?: string; deviceId?: string; label?: string; requestId?: string
    fingerprint?: string; publicKey?: string; replaces?: string; commitment?: string; proof?: string
    copy?: unknown
  }>(request.body)
  if (asked === null) return refuse(400, 'MALFORMED')
  /* The joining till will take a copy of the shop rather than the feed. See
     `sync/copy.ts`; it decides only whether the feed is seeded. */
  const copy = asked.copy === true

  const theirDevice = typeof asked.deviceId === 'string' ? asked.deviceId.trim() : ''
  if (theirDevice === '') return refuse(400, 'MALFORMED')
  /* Tills join the main and nobody else. Refused at the first knock rather
     than after a person has compared digits, and with a code the asking
     screen turns into "join the main till instead". */
  if (!(await mayLetIn(db)).ok) return refuse(409, 'NOT_THE_MAIN')
  /* Three messages arrive on this one path, because they are three turns of one
     conversation and a shop's firewall should not need a fourth port opened to
     hold it: a till asking to come in, that till asking whether it may yet, and
     the old way — a till that was read a code.

     Asking carries a commitment to the joining till's key and not the key --
     see `keyCommitment` -- and every later turn carries the key itself: the
     secret is agreed from it rather than sent. */
  /* A code sent as typed is refused, and spent: it has already crossed the
     wire where anybody could read it. The proof below replaces it. */
  if (typeof asked.code === 'string') {
    withdrawPairing()
    return refuse(400, 'MALFORMED')
  }
  if (typeof asked.requestId !== 'string' && typeof asked.proof !== 'string') {
    if (!isKeyCommitment(asked.commitment)) return refuse(400, 'MALFORMED')
    return await askingToJoin(
      theirDevice, asked.label ?? null, asked.commitment, now, replacesOf(asked.replaces, theirDevice),
    )
  }
  if (!isPairingPublicKey(asked.publicKey)) return refuse(400, 'MALFORMED')
  const joinerKey = asked.publicKey

  if (typeof asked.requestId === 'string') {
    return await pollingAJoin(db, request, asked.requestId.trim(), theirDevice, joinerKey, now, opts, copy)
  }
  if (typeof asked.proof !== 'string') return refuse(400, 'MALFORMED')

  const live = offered

  // Whatever happens next, this code is spent.
  withdrawPairing()

  if (live === null || live.expiresAt <= now) return refuse(403, 'NO_PAIRING_OFFERED')
  if (!constantTimeEquals(await codeProof(live.code, theirDevice, joinerKey), asked.proof)) {
    return refuse(403, 'WRONG_CODE')
  }

  const ours = await pairingKey()
  const secret = await agreeSecret(ours, joinerKey, joinerKey, ours.publicKey)
  const answer = await letThemIn(
    db, request, theirDevice, asked.label ?? null, secret, ours.publicKey, now, opts,
    typeof asked.fingerprint === 'string' ? asked.fingerprint : null,
    replacesOf(asked.replaces, theirDevice),
    copy,
  )
  if (answer.status !== 200) return answer
  /* Proof back the other way, over both keys: the joining till is told this
     came from somebody who was shown the code, not from whoever was in the
     middle of the conversation. */
  const body = JSON.parse(answer.body) as Record<string, unknown>
  return ok({ ...body, confirm: await codeConfirmation(live.code, theirDevice, joinerKey, ours.publicKey) })
}

async function handleFetch(
  db: SqlDriver,
  request: SyncRequest,
  them: string,
): Promise<SyncResponse> {
  const asked = parse<{ since?: number; limit?: number }>(request.body)
  if (asked === null) return refuse(400, 'MALFORMED')

  const since = Number.isFinite(asked.since) ? Number(asked.since) : 0
  const limit = Number.isFinite(asked.limit) ? Math.min(Number(asked.limit), 500) : 200

  /* Their cursor is recorded from what they ask for, not from what we send. A
     till asking for everything after 40 has told us it has 40, and that is the
     only claim about their progress we have any business believing. */
  /* Never backwards. A request that arrives out of order carries an older
     cursor, and moving it back would send everything between twice. */
  await q(db).update(schema.syncPeers)
    .set({ myCursor: since })
    .where(and(
      eq(schema.syncPeers.deviceId, them),
      lt(schema.syncPeers.myCursor, since),
    ))
  /* Being asked is being in touch. A phone that only ever pulls would
     otherwise read as a peer gone quiet, and stop holding the feed back while
     it is still reading it. See `FEED_LEASE_MS`. */
  await q(db).update(schema.syncPeers)
    .set({ lastAgreedAt: clock.iso() })
    .where(eq(schema.syncPeers.deviceId, them))

  return ok(await collectChanges(db, since, limit, them))
}

/**
 * Taking a batch.
 *
 * Idempotent, and it has to be: a batch that we applied and acknowledged, whose
 * acknowledgement was lost on the way back, arrives again. Applying it twice
 * must be the same as applying it once — which it is, because every record is
 * decided against what is already here and an identical copy loses the tiebreak
 * and writes nothing.
 */
export async function handleOffer(
  db: SqlDriver,
  request: SyncRequest,
  them: string,
): Promise<SyncResponse> {
  const batch = parse<ChangeBatch>(request.body)
  if (batch === null || !Array.isArray(batch.records)) return refuse(400, 'MALFORMED')

  /* The same floor the handshake applies, applied again to the batch itself.
     Equality here would have undone Phase 2c entirely: the asking till would
     agree at `hello` and then have every batch it pushed refused, which is a
     shop that reports a successful sync and moves nothing in one direction. */
  if (batch.schemaVersion < MIN_PEER_SCHEMA_VERSION) {
    return refuse(409, 'SCHEMA_MISMATCH')
  }

  /* The batch says who it is from and the signature says who sent it. If those
     disagree, one of them is lying and neither is worth acting on. */
  if (batch.fromDevice !== them) return refuse(403, 'NOT_YOUR_BATCH')

  const [row] = await q(db)
    .select({
      theirCursor: schema.syncPeers.theirCursor,
      myCursor: schema.syncPeers.myCursor,
    })
    .from(schema.syncPeers)
    .where(eq(schema.syncPeers.deviceId, them))

  /* `my_cursor`, and the distinction is the whole of it. `changedHere` asks
     which of *this* till's rows have moved since a point in *this* till's feed,
     and the two cursors count in different feeds: `their_cursor` is how far this
     till has read into theirs. They sit at the same number only while both tills
     have written the same amount, and they run apart the moment one counter is
     busier than the other — the feed is a set, so an edit replaces an entry and
     still burns a seq.
 
     Handed `their_cursor`, this asked "what have we changed since a point that
     means nothing here". Too high and every genuine clash goes unreported: the
     losing edit is dropped and `sync_conflicts` stays empty, which is the one
     failure this table exists to prevent. Too low and the shop is told about
     conflicts it does not have. */
  const both = await changedHere(db, row?.myCursor ?? 0, batch.records)
  await applyBatch(db, batch, both)

  await q(db).update(schema.syncPeers)
    .set({ theirCursor: batch.upTo, lastAgreedAt: clock.iso() })
    .where(and(
      eq(schema.syncPeers.deviceId, them),
      lt(schema.syncPeers.theirCursor, batch.upTo),
    ))

  return ok({ upTo: batch.upTo })
}

/** A `replaces` worth passing on: a string, and not the joining till itself. */
function replacesOf(value: unknown, theirDevice: string): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id === '' || id === theirDevice ? null : id
}
