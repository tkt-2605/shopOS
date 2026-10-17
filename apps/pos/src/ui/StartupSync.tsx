import { useEffect, useState } from 'react'
import { listPeers, tillRole, type PeerHealth } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { onSyncRound, runOnce } from '../core/syncLoop'
import { isOff } from '../core/switches'

/**
 * A till just switched on catches up with the shop before anybody uses it.
 *
 * Until it has, every figure on it is the shop as it was when it went off:
 * the main shows takings without the bills the counters rang up meanwhile, a
 * counter shows stock and credit without what the others did. Seen in a
 * three-till shop: the main came back, and for minutes its screens were
 * yesterday's while the counters, backed off, had not yet called.
 *
 * A counter asks the main at once. The main cannot ask anybody -- the counters
 * dial it -- so it waits for each counter seen lately to call in and say it
 * has nothing more to send. Neither ever holds the shop: a till that cannot be
 * reached is named and the person may start without it, and after half a
 * minute the screen goes by itself. A shop must be able to sell with the
 * network down.
 */

/** How soon "start without it" is offered, and how long before the screen goes regardless. */
const OFFER_SKIP_MS = 5_000
const GIVE_UP_MS = 30_000
/** A till not heard from in this long is not waited for: off for the season, or gone. */
const RECENT_MS = 3 * 24 * 60 * 60 * 1000

/* Once per start of the app, not per sign-in: the next person signing in at
   a till that has been syncing all along would otherwise wait for the
   counters to call in again for nothing. */
const caughtUpThisStart = new WeakSet<object>()

type Stage =
  | { at: 'checking' }
  | { at: 'waiting'; who: string[]; unreachable: string[] }
  | { at: 'done' }

export function StartupSync() {
  const { db, status } = useCore()
  const ready = status.phase === 'ready'
  const [stage, setStage] = useState<Stage>(caughtUpThisStart.has(db) ? { at: 'done' } : { at: 'checking' })
  const [mayLeave, setMayLeave] = useState(false)

  useEffect(() => {
    if (!ready || caughtUpThisStart.has(db)) return
    const started = new Date().toISOString()
    const startedAt = Date.now()
    let over = false
    const finish = () => { over = true; caughtUpThisStart.add(db); setStage({ at: 'done' }) }

    const name = (p: PeerHealth) => p.label ?? `till ${p.deviceId.slice(0, 8)}`
    const recent = (p: PeerHealth) =>
      p.lastAgreedAt !== null && startedAt - Date.parse(p.lastAgreedAt) < RECENT_MS

    const check = async (): Promise<void> => {
      if (over) return
      // Switched off by the vendor where it misbehaves (`switches.ts`): the till opens as it did before it.
      if (isOff('startup_sync')) { finish(); return }
      const peers = (await listPeers(db)).filter((p) => !p.needsPairing && recent(p))
      if (peers.length === 0) { finish(); return }
      // Caught up: heard from since this start, with nothing it said it had still to come.
      const behind = peers.filter((p) => p.lastAgreedAt! < started || (p.behind ?? 0) > 0)
      if (behind.length === 0) { finish(); return }
      const unreachable = behind.filter((p) => p.lastTriedAt !== null && p.lastTriedAt >= started && p.lastError !== null)
      setStage({ at: 'waiting', who: behind.map(name), unreachable: unreachable.map(name) })
      if (unreachable.length > 0) setMayLeave(true)
    }

    const unsubscribe = onSyncRound(() => { void check() })
    const poll = setInterval(() => { void check() }, 1000)
    const offer = setTimeout(() => setMayLeave(true), OFFER_SKIP_MS)
    const giveUp = setTimeout(finish, GIVE_UP_MS)

    void (async () => {
      await check()
      // A counter asks the main now, rather than at its next turn.
      if (!over && await tillRole(db) === 'till') {
        await runOnce(db, true)
        await check()
      }
    })()

    return () => {
      over = true
      unsubscribe()
      clearInterval(poll)
      clearTimeout(offer)
      clearTimeout(giveUp)
    }
  }, [db, ready])

  if (stage.at === 'done' || !ready) return null

  return (
    <div className="startup-sync" role="dialog" aria-modal="true" aria-label="Catching up with the shop">
      <div className="startup-sync-card">
        <div className="four-squares" aria-hidden="true"><span /><span /><span /><span /></div>
        <h2>Catching up with the shop</h2>
        <p>
          {stage.at === 'waiting'
            ? `Waiting for ${stage.who.join(', ')}, so nothing on this till is out of date.`
            : 'Checking what the other tills have done since this one was off.'}
        </p>
        {stage.at === 'waiting' && stage.unreachable.length > 0 && (
          <p className="startup-sync-warn">
            {stage.unreachable.join(', ')} cannot be reached. This till can still sell; its figures will
            leave out what was done there until it is back.
          </p>
        )}
        {mayLeave && (
          <button className="btn" type="button" onClick={() => { caughtUpThisStart.add(db); setStage({ at: 'done' }) }}>
            Start without {stage.at === 'waiting' && stage.who.length === 1 ? 'it' : 'them'}
          </button>
        )}
      </div>
    </div>
  )
}
