import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { EXPECTED_SCHEMA_VERSION } from '../../db/schemaVersion.js'
import { MIN_PEER_SCHEMA_VERSION } from '../../db/migrationKinds.js'
import { deviceId } from '../../device.js'
import { feedHead } from '../changefeed.js'
import { resolveDeviceRegister } from '../registers.js'
import { getSetting } from '../settings.js'
import { clock } from '../../clock.js'
import { currentServingRegister } from './serving.js'
import { isAheadOfUs, noteTillAhead } from '../sync/versionGap.js'
import { hearMain, mainTill } from '../sync/layout.js'
import { type SyncRequest, type SyncResponse, ok, parse } from './wire.js'

/*
 * The handshake, answered: who this till is, what it runs, how far each side
 * has read the other, and who it believes is the main. Apart from the other
 * routes because it is the one every round starts with and the one that
 * carries everything a till learns about the shop before a row moves.
 */

export async function handleHello(db: SqlDriver, them: string, request: SyncRequest): Promise<SyncResponse> {
  /* A newer till asking an older one. It refuses the round at its end; this is
     how the older till -- which may never dial anybody -- finds out it is the
     one that has to be updated. */
  const asker = parse<{
    schemaVersion?: unknown; minPeerSchema?: unknown; mainDevice?: unknown; mainEpoch?: unknown
  }>(request.body)
  if (asker !== null && typeof asker.schemaVersion === 'number') {
    const floor = typeof asker.minPeerSchema === 'number' ? asker.minPeerSchema : asker.schemaVersion
    if (isAheadOfUs(floor)) noteTillAhead(them, asker.schemaVersion, floor)
  }
  /* The asking till's idea of the main. This is how an old main that came
     back steps down: nobody dials a main, so it hears the higher epoch from
     the first till that asks it anything. Before our own answer is built, so
     what we say back is already the settled view. */
  if (asker !== null) await hearMain(db, { device: asker.mainDevice, epoch: asker.mainEpoch })
  const main = await mainTill(db)

  const [row] = await q(db)
    .select({ theirCursor: schema.syncPeers.theirCursor })
    .from(schema.syncPeers)
    .where(eq(schema.syncPeers.deviceId, them))
  return ok({
    deviceId: deviceId(),
    label: await getSetting(db, 'shop_name'),
    shopId: await getSetting(db, 'shop_id'),
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    minPeerSchema: MIN_PEER_SCHEMA_VERSION,
    /* Which counter this till bills on. Two tills on one counter mint invoice
       numbers from the same series, so the asking side refuses before a bill
       crosses and collides. */
    registerId: await resolveDeviceRegister(db, currentServingRegister()),
    // How far we have read of theirs is, from where they stand, how far they
    // have been read. The two cursors are one number seen from two sides.
    yourCursorWithThem: row?.theirCursor ?? 0,
    /* And how far ours goes, which is the half that was missing. Without it the
       asking till can work out what it owes us and cannot work out what we owe
       it — so its screen says "everything sent" while it is ninety-five bills
       short, and every total it prints is short with them. */
    head: await feedHead(db),
    /* Answering this request is the proof. A peer that cannot be dialled never
       reaches this code, so the value is always true here — and it is sent
       anyway, because the field is how a client that *cannot* answer says so
       when it is the one holding the conversation. */
    answers: true,
    /* This till's own clock. Nothing secret — the request that got here was
       signed with a timestamp of the caller's, so both machines already know
       each other's idea of the time. What it buys is the shop being told while
       the two are still talking, rather than at the moment every round starts
       failing with `STALE`. */
    now: clock.now(),
    /* Who the main is, as settled above. Null fields on a shop with none,
       which the asking side reads as no claim. */
    mainDevice: main.device,
    mainEpoch: main.epoch,
  })
}
