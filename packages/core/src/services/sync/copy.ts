import type { SqlDriver } from '../../db/driver.js'
import { EXPECTED_SCHEMA_VERSION } from '../../db/schemaVersion.js'
import { getSetting } from '../settings.js'
import { mainTill } from './layout.js'

/*
 * A new till joining a shop takes a copy of the main's database, rather than
 * the shop through the change feed.
 *
 * The feed is for what has changed since two tills last agreed. Handing a
 * whole shop through it -- every row seeded into the feed, then two hundred
 * records a round -- is five thousand rounds for a shop of a million rows, and
 * it re-sends the shop to every till already paired, because seeding puts
 * every row back in the feed for all of them. Every replicated system with a
 * leader does the same thing here: a new replica starts from a snapshot that
 * records the log position it was taken at, and reads the log from there.
 * Postgres's base backup and LSN, MySQL's dump and GTID set, Redis's full
 * resync. `docs/specs/one-main-till.md`, *Joining*.
 *
 * Core says what is asked and what is checked. The bytes are the host's: the
 * main's copy is a `VACUUM INTO` the app takes in Rust, it travels in chunks
 * that never pass through the webview, and installing it is a restore with
 * this till's own tables carried across (`sql/carry-over-after-copy.sql`).
 */

/** What the main hands a till that asks for a copy of the shop. */
export interface ShopCopy {
  /** One-time, short-lived, and the only thing that fetches the bytes. */
  token: string
  bytes: number
  sha256: string
  /**
   * The last seq the main's feed had issued when the copy was taken -- from
   * `sqlite_sequence`, not the largest seq still in the feed, so a feed pruned
   * empty still says how far it got. Everything up to it is in the copy.
   */
  feedHead: number
  schemaVersion: number
}

/** The main's side: take a copy for a till that asked. */
export interface CopyMaker {
  make(forPeer: string): Promise<Omit<ShopCopy, 'schemaVersion'>>
}

/** The joining side: fetch the bytes, and install them. */
export interface CopyHost {
  /** Returns where the verified file is. */
  download(copy: ShopCopy, baseUrl: string): Promise<string>
  /** Stages the copy as this till's database. In the app this restarts. */
  install(path: string, plan: CopyPlan): Promise<void>
}

export interface CopyPlan {
  /** The main the copy came from, whose cursor starts at `feedHead`. */
  mainDevice: string
  feedHead: number
  sha256: string
}

export type CopyRefusal =
  /** This till already holds a shop; it joins by the feed instead. */
  | 'HOLDS_UNSENT'
  /** The two builds differ, and a copy is a whole database: update first. */
  | 'VERSION_DIFFERS'

/**
 * Whether taking a copy could lose anything this till holds.
 *
 * A till that has never been set up has nothing of the shop's to lose. Any
 * other till may, and the copy replaces its database, so it never takes one:
 * it joins by the feed, where both sides merge and nothing is replaced.
 *
 * This used to ask the feed what had not reached the main, which is the wrong
 * question after a main dies. What the dead main acknowledged was pruned from
 * this till's feed, so the feed said "nothing unsent" about bills that are on
 * no other till -- and the copy from the new main would have erased them.
 */
export async function wouldLoseWork(db: SqlDriver): Promise<boolean> {
  return await getSetting(db, 'shop_id') !== null
}

/**
 * Takes a copy of the shop from the main and installs it.
 *
 * `ask` is the signed request -- `requestCopy` in `syncClient.ts` -- passed in
 * so this file stays on the protocol's side of the wire.
 */
export async function takeCopy(
  db: SqlDriver,
  main: { deviceId: string; baseUrl: string },
  ask: () => Promise<ShopCopy>,
  host: CopyHost,
): Promise<{ ok: true } | { ok: false; code: CopyRefusal }> {
  if (await wouldLoseWork(db)) return { ok: false, code: 'HOLDS_UNSENT' }

  const copy = await ask()
  /* Exactly equal. Rows cross between builds a migration apart because each
     is merged on arrival; a copy is not merged, it *is* the database, and a
     file from a newer build is one this build cannot open. */
  if (copy.schemaVersion !== EXPECTED_SCHEMA_VERSION) return { ok: false, code: 'VERSION_DIFFERS' }

  const path = await host.download(copy, main.baseUrl)
  await host.install(path, { mainDevice: main.deviceId, feedHead: copy.feedHead, sha256: copy.sha256 })
  return { ok: true }
}

/** Whether this till may hand out copies: only the main, or a shop with none. */
export async function mayHandOutCopies(db: SqlDriver, me: string | null): Promise<boolean> {
  const main = await mainTill(db)
  return main.device === null || main.device === me
}
