import {
  syncUntilDone, httpTransport, pairedPeers, pruneAcknowledged, recordAttempt,
  serveAs, rememberAddress, SyncHttpError, tillRole, type SqlDriver,
} from '@shopos/core'
import { chosenRegister } from './device'
import { caughtUpWith } from './outOfDate'
import { caughtUpAfterRestore } from './restoreHold'
import { logEvent } from './log'
import { servingOn, lookAround, keepTheDoorRight } from './syncHost'
import { syncFetch } from './syncFetch'
import { nextBackoff } from '@shopos/core'

/**
 * Catching up without anybody pressing anything.
 *
 * A button is honest and it is not enough: the point of two tills is that a bill
 * rung up at the front counter is on the back one before anybody goes looking,
 * and nobody presses "catch up now" every ninety seconds all day.
 *
 * ── What it is careful about ───────────────────────────────────────────────
 *
 * **It backs off a till that is not there.** A counter switched off at four
 * o'clock would otherwise be dialled every thirty seconds until closing, filling
 * the log and the network with the same failure. Each peer has its own wait,
 * doubling up to a few minutes, and reset the moment it answers.
 *
 * **It never overlaps itself.** A round that takes longer than the interval —
 * a till a fortnight behind, on a slow disk — would otherwise be started again
 * underneath itself, and two syncs with one peer fight over the same cursors.
 *
 * **It is silent when it works.** A failure is recorded against the peer and
 * shown on the Settings screen; a success says nothing at all. The alternative
 * is a counter that interrupts a queue of customers to announce that a fact it
 * already had is still true.
 *
 * **It does nothing at all until a shop has paired.** Which is most shops.
 */

/**
 * The floor, not the pace.
 *
 * A till also syncs the moment it writes anything — see `nudgeSync` — so this
 * is what catches a round that was missed, a peer that has come back, and the
 * other till's changes on a counter that is not selling anything right now.
 */
const EVERY_MS = 45_000

/**
 * How often a till that syncs through a main asks it.
 *
 * Shorter than the floor above, because a till is now the only side that
 * dials: the main has no address for its tills and never starts a round, so a
 * bill rung up at the main reaches a till only when that till next asks. A
 * hello that finds nothing is one small signed request on the LAN.
 */
const TILL_EVERY_MS = 15_000

/**
 * How long a write waits for the writes beside it.
 *
 * Submitting one bill is a transaction and several rows; a stock count is
 * hundreds. Syncing per row would mean a round per row, all of them carrying
 * the same batch. Short enough that nobody at the other counter notices, long
 * enough that one action is one round.
 */
const NUDGE_MS = 400

interface PeerState {
  /** Not before this time. Zero when the peer is answering normally. */
  quietUntil: number
  backoff: number
}

const state = new Map<string, PeerState>()
let timer: ReturnType<typeof setInterval> | null = null
let running = false
let nudge: ReturnType<typeof setTimeout> | null = null
/** A nudge that arrived mid-round, to be honoured when that round finishes. */
let againWhenDone = false

export interface LoopReport {
  peer: string
  ok: boolean
  received: number
  sent: number
  contested: number
  /**
   * Records that arrived and could not be applied. See migration 038.
   *
   * Carried separately from `error` because it is not one: the round worked and
   * the cursor moved. It is the other thing a shopkeeper is owed -- a round that
   * dropped something, as against a round that stalled.
   */
  quarantined: number
  error?: string
}

/**
 * What one pass actually did, as opposed to what it found.
 *
 * `reports` alone could not tell three different situations apart, because all
 * three of them are an empty array: this shop has never paired with anything,
 * a round was already in flight so this one did nothing, and a round that
 * reached every peer and had nothing to carry. The screen was reading the
 * first two as the third and announcing that both tills agreed -- to shops
 * with one till, which is most of them.
 */
export interface LoopRound {
  /** Peers this till is paired with, whether or not each answered. */
  peers: number
  /** A round was already running; this call did nothing and reports nothing. */
  skipped: boolean
  reports: LoopReport[]
}

/**
 * Screens watching what the loop does, so their view stays current.
 *
 * A set rather than the one callback this used to be. With a single slot the
 * last screen to mount silently replaced the one before it, which was fine
 * while Settings was the only screen that cared and wrong the moment a bill
 * list wanted to know too — the Settings card would stop updating, or the list
 * would, depending on which happened to mount last.
 */
const watchers = new Set<(reports: LoopReport[]) => void>()

/** Returns the unsubscribe, so a screen cannot take somebody else's off. */
export function onSyncRound(fn: (reports: LoopReport[]) => void): () => void {
  watchers.add(fn)
  return () => { watchers.delete(fn) }
}

/** When the last round started, so a tick knows whether the floor is due. */
let lastRoundAt = 0

/* Every `TILL_EVERY_MS`, a till that syncs through a main asks it; every other
   till keeps the old floor. Asked per tick, because a handover changes which
   one this is. */
async function tick(db: SqlDriver): Promise<void> {
  const due = Date.now() - lastRoundAt >= EVERY_MS
  if (due || await tillRole(db) === 'till') await runOnce(db)
}

export function startSyncLoop(db: SqlDriver): void {
  if (timer !== null) return
  timer = setInterval(() => { void tick(db).catch(() => undefined) }, TILL_EVERY_MS)
  // Once at the start, so a till that has just been switched on does not wait
  // three quarters of a minute before it knows anything.
  void runOnce(db)
}

export function stopSyncLoop(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  if (nudge !== null) {
    clearTimeout(nudge)
    nudge = null
  }
  againWhenDone = false
  state.clear()
}

/**
 * Something was written here, so catch up now rather than at the next tick.
 *
 * Forty-five seconds is a long time to stand at the other counter waiting for a
 * bill that has already been rung up. The loop stays as the floor -- it is what
 * notices a till coming back, and what pulls a counter that is quiet -- and
 * this is what makes the common case immediate.
 *
 * Called from the driver the app hands core, so it covers every write there is
 * rather than the ones somebody remembered to annotate. `nudgingDriver` carries
 * the argument for hooking it there.
 *
 * Does nothing at all in a shop with one till, because the loop is not running:
 * `startSyncLoop` is called once a shop has paired.
 */
export function nudgeSync(db: SqlDriver): void {
  if (timer === null) return

  /* Mid-round, and most of these are the round itself writing the rows it just
     pulled. Honoured once it finishes rather than dropped, because the one that
     matters -- a sale rung up while a round was in flight -- is indistinguishable
     from here, and an extra round that finds nothing costs a hello. */
  if (running) { againWhenDone = true; return }

  if (nudge !== null) clearTimeout(nudge)
  nudge = setTimeout(() => {
    nudge = null
    /* Not forced. `force` skips the backoff, and a backoff is this till's
       record that a peer is not answering — so forcing here meant every bill,
       every stock movement and every price edit knocking on a machine that is
       switched off, forty times an hour, each one waiting for its own timeout
       before the counter's own write could be reported as done.
 
       A person pressing "catch up now" may bypass a backoff: they are standing
       in front of the shop and have just switched the other till on. A bill may
       not — it has no new information about whether that till is there. */
    void runOnce(db, false)
  }, NUDGE_MS)
}

/**
 * One pass over every peer. Exported so the button and the loop are the same
 * code — a "catch up now" that took a different path would be a second
 * implementation to keep in step, and the one people press least would rot.
 */
export async function runOnce(db: SqlDriver, force = false): Promise<LoopRound> {
  if (running) return { peers: 0, skipped: true, reports: [] }
  running = true
  lastRoundAt = Date.now()
  const reports: LoopReport[] = []
  let paired = 0

  try {
    // The answering side cannot read device.json; it is told, every round, so a
    // counter chosen five minutes ago is not still being announced as the old one.
    serveAs(chosenRegister())

    /* Told to the other till on every request, so it can record where to reach
       us. A single-till shop is not listening and sends nothing, which is
       correct: there is nobody to come back to it. */
    const listenPort = (await servingOn())?.port ?? null

    const peers = await pairedPeers(db)
    paired = peers.length
    const now = Date.now()

    for (const peer of peers) {
      const mine = state.get(peer.deviceId) ?? { quietUntil: 0, backoff: 0 }
      if (!force && mine.quietUntil > now) continue

      try {
        /* Which counter this machine sits at, so the other till can be refused
           if it is on the same one — two tills on one counter mint invoice
           numbers from the same series and collide on the first bill. */
        const round = await syncUntilDone(db, httpTransport(peer, syncFetch, { listenPort }), 50, chosenRegister())

        if (round.ok) {
          /* Coming back after a spell of failures is worth a line: it is what
             turns a wall of "cannot reach" into a span with an end. */
          if (mine.backoff > 0) {
            logEvent('info', 'sync', `${peer.deviceId} is answering again`)
          }
          state.set(peer.deviceId, { quietUntil: 0, backoff: 0 })
          await recordAttempt(db, peer.deviceId, null)
          await caughtUpWith(peer.deviceId)
          // Everything the other till had for this one has arrived.
          if (!round.more) await caughtUpAfterRestore()
          /* Never silent. A round that set a record aside is the one case
             where everything looks like it worked and the two tills genuinely
             differ, so it is written down even though nothing failed. */
          if (round.quarantined > 0) {
            logEvent(
              'warn', 'sync',
              `${round.quarantined} record(s) from ${peer.deviceId} could not be applied and were set aside`,
            )
          }
          /* The same for a cache the merge found out of line and left alone
             on purpose -- points or returned quantities that a record not
             here yet may explain. See `MergeOutcome.cachesHeld`. */
          if (round.cachesHeld > 0) {
            logEvent(
              'warn', 'sync',
              `${round.cachesHeld} loyalty or return figure(s) differ from their records and were left for a person`,
            )
          }
          reports.push({
            peer: peer.deviceId,
            ok: true,
            received: round.received,
            sent: round.sent,
            contested: round.contested.length,
            quarantined: round.quarantined,
          })
        } else {
          /* A refusal is not a network failure and backing off would be wrong:
             a schema mismatch is fixed by updating a till, and until somebody
             does, saying so every round is the correct amount of noise. */
          /* Which till is out of date, because the fix is on one machine and
             the sentence has to name it. */
          const code = round.code !== 'SCHEMA_MISMATCH' ? round.code
            : round.behind === 'mine' ? 'THIS_TILL_OUTDATED' : 'PEER_OUTDATED'
          /* This till is the old one: only updating it changes the answer, and
             an update restarts the app, so there is nothing to gain by asking
             again before then. The banner is saying so on every screen. */
          if (code === 'THIS_TILL_OUTDATED') {
            state.set(peer.deviceId, { quietUntil: Number.POSITIVE_INFINITY, backoff: 0 })
          }
          await recordAttempt(db, peer.deviceId, code)
          /* Recorded against the peer for the Settings screen, and written down
             as well. `recordAttempt` keeps the latest state; the log keeps the
             sequence, which is what answers "since when". */
          logEvent('warn', 'sync', `${peer.deviceId} refused us: ${code}`)
          reports.push({
            peer: peer.deviceId, ok: false, received: 0, sent: 0,
            contested: 0, quarantined: 0, error: code,
          })
        }
      } catch (err) {
        /* An answer, not a silence. `syncWith` returns `{ok:false}` for the
           refusals it decides itself, but one the far side decides -- it does
           not know us, the signature did not verify -- arrives as a thrown
           `SyncHttpError` from the transport, and this catch used to file it
           under "could not be reached". Three things came of that: an hour of
           backoff against a till that was answering every time; "Cannot reach
           the back counter" on a screen about a till that had just replied; and
           the message stored rather than the code, which `explainRefusal` then
           wrapped a second time -- "The other till refused: The other till
           refused: UNKNOWN_PEER".

           `syncBackoff.ts` is where the distinction is written down, and this
           is the one place that was not keeping it. */
        if (err instanceof SyncHttpError) {
          await recordAttempt(db, peer.deviceId, err.code)
          logEvent('warn', 'sync', `${peer.deviceId} refused us: ${err.code}`)
          reports.push({
            peer: peer.deviceId, ok: false, received: 0, sent: 0,
            contested: 0, quarantined: 0, error: err.code,
          })
          continue
        }

        // Could not be reached at all: switched off, asleep, moved, unplugged.
        const wait = nextBackoff(mine.backoff)
        state.set(peer.deviceId, { quietUntil: now + wait, backoff: wait })
        await recordAttempt(db, peer.deviceId, describe(err))

        /* Or still there, at a different address. A till learns where a peer is
           from the requests that peer makes, which is no help at all when
           neither can reach the other -- both sit holding an address that was
           true yesterday, backing off from each other for ever.

           The shout is the way out: the far till answers with where it is now.
           A moved machine, a router that renumbered overnight, a port that came
           back different. Only after a failure, so a shop where everything
           works never broadcasts anything. */
        void repairAddress(db, peer.deviceId, peer.baseUrl)
        /* Only the first failure in a run of them. This fires every 45 seconds
           against a till that is switched off for the night, and eight hours of
           "could not reach the back counter" would push everything worth
           reading out of a five-megabyte log. The backoff state is what says
           whether this is news. */
        if (mine.backoff === 0) {
          logEvent('warn', 'sync', `cannot reach ${peer.deviceId}: ${describe(err)}`)
        }
        reports.push({
          peer: peer.deviceId, ok: false, received: 0, sent: 0,
          contested: 0, quarantined: 0, error: describe(err),
        })
      }
    }

    /* Only once every peer has been asked, and only what every one of them has
       confirmed. A change dropped early is one a switched-off till never learns
       about, and nothing afterwards will mention it again. */
    if (peers.length > 0) await pruneAcknowledged(db)

    /* A round is where a till hears that it has become the main, or stopped
       being it, so the door is checked after every one. */
    await keepTheDoorRight(db).catch((err: unknown) => logEvent('warn', 'sync', describe(err)))
  } finally {
    running = false
  }

  /* A write landed while this round was in flight, and only one more round is
     owed however many there were.

     `moved` is what stops this being perpetual. Every round writes -- cursors,
     `recordAttempt`, the rows a merge applies -- and every one of those writes
     comes back through the driver as a nudge, so re-arming unconditionally
     would mean a round every four hundred milliseconds for ever. A round that
     carried nothing in either direction has nothing to follow up, and a shop at
     rest goes quiet. */
  const moved = reports.some((r) => r.ok && (r.sent > 0 || r.received > 0))
  const owed = againWhenDone
  againWhenDone = false
  if (owed && moved) nudgeSync(db)

  /* One screen throwing must not stop the next one hearing. They are unrelated
     views of the same round and a broken one is a broken one, not a silent
     list. */
  if (reports.length > 0) {
    for (const watcher of watchers) {
      try { watcher(reports) } catch (err) { logEvent('warn', 'sync', describe(err)) }
    }
  }
  return { peers: paired, skipped: false, reports }
}

/**
 * Asks the network where a till went, after failing to reach where it was.
 *
 * Deliberately quiet about failing: this runs after a round has already failed
 * and reported why, and a shout that finds nothing is the ordinary case for a
 * till that is switched off. Whatever it learns is used by the *next* round —
 * nothing is retried here, because the backoff has just decided when that is.
 *
 * One caveat worth knowing on a machine running several tills at once: only one
 * process can hold the discovery port, so only one of them answers a shout. On
 * a shop's counters, where each till is its own machine, they all do.
 */
async function repairAddress(db: SqlDriver, device: string, staleUrl: string): Promise<void> {
  try {
    const found = (await lookAround()).find((t) => t.device === device)
    if (found === undefined) return

    const url = `http://${found.address}`
    if (url === staleUrl) return

    await rememberAddress(db, device, url)
    logEvent('info', 'sync', `${device} has moved to ${found.address}`)
  } catch { /* The shout itself failed. The round already said what it said. */ }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
