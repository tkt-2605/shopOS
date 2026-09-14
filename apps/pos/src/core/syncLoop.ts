import {
  syncUntilDone, httpTransport, pairedPeers, pruneAcknowledged, recordAttempt,
  serveAs, type SqlDriver,
} from '@shopos/core'
import { chosenRegister } from './device'

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

/** Long enough not to be a nuisance, short enough that a bill lands before
 *  anybody walks to the other counter to look for it. */
const EVERY_MS = 45_000

/** A till that is off should be tried occasionally, not constantly. */
const BACKOFF_START_MS = 60_000
const BACKOFF_MAX_MS = 10 * 60_000

interface PeerState {
  /** Not before this time. Zero when the peer is answering normally. */
  quietUntil: number
  backoff: number
}

const state = new Map<string, PeerState>()
let timer: ReturnType<typeof setInterval> | null = null
let running = false

export interface LoopReport {
  peer: string
  ok: boolean
  received: number
  sent: number
  contested: number
  error?: string
}

let onRound: ((reports: LoopReport[]) => void) | null = null

/** A screen can watch what the loop does, so its own view stays current. */
export function onSyncRound(fn: ((reports: LoopReport[]) => void) | null): void {
  onRound = fn
}

export function startSyncLoop(db: SqlDriver): void {
  if (timer !== null) return
  timer = setInterval(() => { void runOnce(db) }, EVERY_MS)
  // Once at the start, so a till that has just been switched on does not wait
  // three quarters of a minute before it knows anything.
  void runOnce(db)
}

export function stopSyncLoop(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  state.clear()
}

/**
 * One pass over every peer. Exported so the button and the loop are the same
 * code — a "catch up now" that took a different path would be a second
 * implementation to keep in step, and the one people press least would rot.
 */
export async function runOnce(db: SqlDriver, force = false): Promise<LoopReport[]> {
  if (running) return []
  running = true
  const reports: LoopReport[] = []

  try {
    // The answering side cannot read device.json; it is told, every round, so a
    // counter chosen five minutes ago is not still being announced as the old one.
    serveAs(chosenRegister())

    const peers = await pairedPeers(db)
    const now = Date.now()

    for (const peer of peers) {
      const mine = state.get(peer.deviceId) ?? { quietUntil: 0, backoff: 0 }
      if (!force && mine.quietUntil > now) continue

      try {
        /* Which counter this machine sits at, so the other till can be refused
           if it is on the same one — two tills on one counter mint invoice
           numbers from the same series and collide on the first bill. */
        const round = await syncUntilDone(db, httpTransport(peer), 50, chosenRegister())

        if (round.ok) {
          state.set(peer.deviceId, { quietUntil: 0, backoff: 0 })
          await recordAttempt(db, peer.deviceId, null)
          reports.push({
            peer: peer.deviceId,
            ok: true,
            received: round.received,
            sent: round.sent,
            contested: round.contested.length,
          })
        } else {
          /* A refusal is not a network failure and backing off would be wrong:
             a schema mismatch is fixed by updating a till, and until somebody
             does, saying so every round is the correct amount of noise. */
          await recordAttempt(db, peer.deviceId, round.code)
          reports.push({
            peer: peer.deviceId, ok: false, received: 0, sent: 0,
            contested: 0, error: round.code,
          })
        }
      } catch (err) {
        // Could not be reached at all: switched off, asleep, moved, unplugged.
        const wait = mine.backoff === 0
          ? BACKOFF_START_MS
          : Math.min(mine.backoff * 2, BACKOFF_MAX_MS)
        state.set(peer.deviceId, { quietUntil: now + wait, backoff: wait })
        await recordAttempt(db, peer.deviceId, describe(err))
        reports.push({
          peer: peer.deviceId, ok: false, received: 0, sent: 0,
          contested: 0, error: describe(err),
        })
      }
    }

    /* Only once every peer has been asked, and only what every one of them has
       confirmed. A change dropped early is one a switched-off till never learns
       about, and nothing afterwards will mention it again. */
    if (peers.length > 0) await pruneAcknowledged(db)
  } finally {
    running = false
  }

  if (onRound !== null && reports.length > 0) onRound(reports)
  return reports
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
