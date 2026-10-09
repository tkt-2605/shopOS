import { useCallback, useEffect, useState } from 'react'
import {
  listPeers,
  offerPairing, withdrawPairing, entitled,
  recentConflicts, acknowledgeConflicts,
  quarantinedRecords, acknowledgeQuarantine,
  forgetPeer,
  getSetting,
  tillRole, mainTill, makeThisTheMain, handTheMainTo,
  type PeerHealth, type RecordedConflict, type QuarantinedRecord, type Role, type MainTill,
} from '@shopos/core'
import { runOnce, onSyncRound } from '../core/syncLoop'
import { syncNotice } from '../core/syncNotice'
import { syncStatus, ago } from '../core/syncStatus'
import { explain, explainRefusal, explainQuarantine, isVersionGap, looksLikeARefusal } from '../core/syncWords'
import { startServing, stopServing, servingOn, keepTheDoorRight, type ServeInfo } from '../core/syncHost'
import { useCore } from '../core/CoreProvider'
import { chosenRegister } from '../core/device'
import { takeCounter } from '../core/counters'
import { caughtUpWith } from '../core/outOfDate'
import { Card, Alert } from './components'
import { useConfirm } from './useConfirm'

/**
 * Two tills in one shop.
 *
 * This screen belongs to the till that **already has the shop**, and it does
 * one job: add another one. The joining half is not here, because it cannot be
 * — a till that has been set up has a shop of its own, and two shops cannot be
 * merged. It used to be here anyway, as a form with fine print underneath
 * explaining that it would not work, which is a control that is always visible
 * and almost always wrong. The joining half lives where it is true, on the
 * first screen a new machine ever shows.
 *
 * There is no switch for answering. A shop with a second till answers whenever
 * it is running and one with none stays closed — `serveIfPaired` says why that
 * is a fact rather than a question — and "Add a till" opens the door for as
 * long as it takes to let one in.
 */

export function SyncCard() {
  const { db, shop, registerId, reloadRegister, user } = useCore()
  const [confirmUi, ask] = useConfirm()
  const [serving, setServing] = useState<ServeInfo | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [peers, setPeers] = useState<PeerHealth[]>([])
  const [conflicts, setConflicts] = useState<RecordedConflict[]>([])
  const [refused, setRefused] = useState<QuarantinedRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /* What this till calls its shop when another one shouts on the network: a
     name and an opaque id, enough to tell two shops apart on one wire. */
  const [shopId, setShopId] = useState<string | null>(null)
  /* Which till the shop syncs through. See `sync/layout.ts` in core. */
  const [role, setRole] = useState<Role>('alone')
  const [main, setMain] = useState<MainTill>({ device: null, epoch: 0 })

  const status = syncStatus(peers)
  const naming = (p: PeerHealth | undefined, fallback: string) =>
    p === undefined ? fallback : p.label ?? `till ${p.deviceId.slice(0, 8)}`
  const mainName = naming(peers.find((p) => p.deviceId === main.device), 'the main till')

  const refresh = useCallback(async () => {
    setServing(await servingOn())
    setPeers(await listPeers(db))
    setConflicts(await recentConflicts(db, { limit: 20 }))
    setRefused(await quarantinedRecords(db, { limit: 20 }))
    setShopId(await getSetting(db, 'shop_id'))
    setRole(await tillRole(db))
    setMain(await mainTill(db))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])

  /* The catch-up runs whether or not this screen is open, so the screen follows
     it rather than keeping its own idea of when the tills last agreed. */
  useEffect(() => onSyncRound(() => { void refresh() }), [refresh])

  // A code that lapses on the Rust side should stop being shown here too.
  useEffect(() => {
    if (code === null) return
    const timer = setTimeout(() => setCode(null), 10 * 60 * 1000)
    return () => clearTimeout(timer)
  }, [code])

  /**
   * Opens the door and shows what to type at the other machine.
   *
   * The port may already be open — a shop that has paired once answers all day
   * — in which case this only mints the code.
   */
  async function addATill() {
    setError(null)

    /* Asked here so the answer arrives before the port opens and before a code
       is minted, rather than after somebody has typed one into the other
       machine and been refused there. `letThemIn` asks again and is the check
       that actually holds; this one exists so the refusal reaches the person
       standing at the till that can do something about it. */
    if (!await entitled(db, 'multiTill')) {
      setError(
        'This shop is on the one-counter plan. The counter you are on is '
        + 'unaffected and goes on working exactly as it does now — adding a '
        + 'second one is what needs the multi-counter plan. Settings, Licence '
        + 'has this shop’s id to quote when you ask us for it.',
      )
      return
    }

    /* This till has been billing on the shop's first counter without ever
       being asked, which is right while it is the only one. The moment another
       till is let in it stops guessing -- two tills on one guess mint the same
       invoice numbers -- so the counter it is on is written down now, while it
       is still the only till, and claimed where the new one will see it. */
    if (chosenRegister() === null && registerId !== '') {
      await takeCounter(db, registerId)
      await reloadRegister()
    }

    try {
      if (serving === null) {
        // No port: the one this machine had last time, so an address a peer
        // wrote down goes on working across a restart.
        await startServing(db, undefined, { name: shop.name, id: shopId })
      }
      setCode(offerPairing())
      await refresh()
    } catch (err) {
      setError(
        'This machine could not open the port other tills knock on. '
        + 'Another program may already be using it, or Windows may be blocking it. '
        + String(err),
      )
    }
  }

  /**
   * Stops offering, and closes the door behind it if nobody has come in.
   *
   * A shop that has paired keeps answering: its tills have to reach it. A shop
   * that was only ever showing a code goes back to being closed, which is the
   * security property the old toggle existed to protect.
   */
  async function doneAdding() {
    withdrawPairing()
    setCode(null)
    if (peers.length === 0) await stopServing()
    await refresh()
  }

  /**
   * A till that is not coming back.
   *
   * There was no way to forget a peer anywhere in the product, and what that
   * cost was not tidiness: the change feed is held at the lowest cursor of
   * every peer, so one machine that was sold or dropped pins the feed of every
   * remaining till for the life of the shop. It grows, every round reads
   * further into it, and nothing anywhere says why.
   *
   * Confirmed, because the counter that till was billing on is released with
   * it — which is the point, and is also why this must not be a stray click.
   */
  async function forget(peer: PeerHealth) {
    const who = peer.label ?? `till ${peer.deviceId.slice(0, 8)}`
    const agreed = await ask(
      `Forget ${who}?\n\n`
      + 'Do this only if that machine is gone for good. Anything it had and this '
      + 'one has not seen is lost, and the counter it was billing on becomes free '
      + `for another till.\n\n`
      + 'If it comes back, it can be paired again.',
    )
    if (!agreed) return

    setError(null)
    await forgetPeer(db, peer.deviceId)
    // A till that is gone is not one this till is out of date with any more.
    await caughtUpWith(peer.deviceId)
    setNotice(`${who} has been forgotten.`)
    await refresh()
  }

  /**
   * The main is gone, or the owner wants it here.
   *
   * Confirmed, and said plainly, because it is the one action on this screen
   * that changes what every other till does. Never automatic: see
   * `makeThisTheMain` for why a two-till shop has to switch by hand.
   */
  async function promote() {
    const agreed = await ask(
      'Make this the main till?\n\n'
      + 'Do this when the main till is gone for good, or to move the main here. '
      + 'The other tills will need to be paired with this one: press Add a till '
      + 'here, and choose Join a shop on each of them.\n\n'
      + 'If the old main till comes back, it will see that this one is the main '
      + 'and step down on its own. Nothing it holds is lost.',
    )
    if (!agreed) return
    setError(null)
    try {
      await makeThisTheMain(db, user?.id)
      await keepTheDoorRight(db)
      setNotice('This is now the main till. Pair the other tills with it.')
    } catch (err) {
      setError(explain(err))
    }
    await refresh()
  }

  /**
   * The main hands its place to a till, while both are working.
   *
   * The gentle move: that till takes over the next time it catches up with
   * this one, and this one goes on passing bills between it and every other
   * till until each has been paired with the new main.
   */
  async function handOver(peer: PeerHealth) {
    const who = naming(peer, 'that till')
    const agreed = await ask(
      `Make ${who} the main till?\n\n`
      + `${who} takes over the next time it catches up with this till. This till `
      + 'goes on passing bills between it and the other tills until each of them '
      + `has been paired with ${who}, so nothing stops in between.`,
    )
    if (!agreed) return
    setError(null)
    try {
      await handTheMainTo(db, peer.deviceId, user?.id)
      setNotice(`${who} will be the main till from its next catch-up.`)
    } catch (err) {
      setError(explain(err))
    }
    await refresh()
  }

  /* The same code the background loop runs. A "catch up now" that took its own
     path would be a second implementation to keep in step, and the one people
     press least would be the one that rots. */
  async function syncNow() {
    setError(null)
    setBusy(true)
    try {
      /* "Both tills agree" is a claim about a conversation that happened,
         and it used to be printed for a shop that has no second till: an empty
         report list read as "nothing disagreed". See `syncNotice`. */
      const said = syncNotice(await runOnce(db, true))
      if (said.kind === 'error') setError(explainRefusal(said.code))
      else if (said.kind === 'notice') setNotice(said.text)
      await refresh()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function dismissConflicts() {
    await acknowledgeConflicts(db)
    await refresh()
  }

  async function dismissRefused() {
    await acknowledgeQuarantine(db)
    await refresh()
  }

  return (
    <Card title="Two tills">
      {confirmUi}
      {error && <Alert>{error}</Alert>}
      {notice && !error && <Alert kind="ok">{notice}</Alert>}

      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
        Each till keeps the whole shop and they catch up with each other when they
        can. Either one sells on its own with the network down — that is the point
        of it. <strong>Bills travel across the shop network unencrypted</strong>,
        so this is for a network you control, not a shared one.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section>
          {/* The one question a shopkeeper has, and its one answer. The table
              below is the detail behind it, for whoever wants the detail. */}
          <div style={{ fontSize: 14, fontWeight: 600 }}>{status.text}</div>

          {/* Which till is the main, said once, with the one thing a person can
              do about it from here. */}
          {role === 'main' && (
            <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 6 }}>
              This is the <strong>main till</strong>. The other tills sync through it,
              and a new till joins it here.
            </div>
          )}
          {role === 'till' && (
            <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 6 }}>
              This till syncs through the main till, <strong>{mainName}</strong>. A new
              till joins there, not here.{' '}
              <button className="link-btn" onClick={() => void promote()}>
                Make this the main till
              </button>
            </div>
          )}
          {role === 'equals' && (
            <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 6 }}>
              These tills were paired before ShopOS had a main till. Make one of them
              the main — usually the one that is always on.{' '}
              <button className="link-btn" onClick={() => void promote()}>
                Make this the main till
              </button>
            </div>
          )}

          {role === 'till' ? null : code === null
            ? (
              <button className="btn sm" style={{ marginTop: 10 }} onClick={() => void addATill()}>
                Add a till
              </button>
            )
            : (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12.5, marginBottom: 6 }}>
                  On the new till, choose <strong>Join a shop</strong> and give it
                  this machine{'’'}s address and this code.
                </div>
                <div style={{ fontSize: 12.5 }}>
                  Address <strong>{serving?.address ?? `port ${serving?.port ?? 7801}`}</strong>
                </div>
                <div style={{ fontSize: 24, letterSpacing: 4, fontWeight: 600, marginTop: 4 }}>
                  {code}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>
                  It lasts ten minutes and <strong>one attempt uses it up</strong>,
                  right or wrong — show a fresh one if it is mistyped.
                </div>
                <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => void doneAdding()}>
                  Done
                </button>
              </div>
            )}
        </section>

        {peers.length > 0 && (
          <section>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Paired with</div>
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>Till</th><th>Last agreed</th><th>Waiting</th>
                    {/* What that till has which this one has not seen. The half
                        nothing could say before migration 044, and the half a
                        total on a report depends on. */}
                    <th>Behind</th><th /><th />
                  </tr>
                </thead>
                <tbody>
                  {peers.map((p) => (
                    <tr key={p.deviceId}>
                      <td>{p.label ?? p.deviceId.slice(0, 8)}</td>
                      <td>{ago(p.lastAgreedAt)}</td>
                      <td className="num">{p.waiting === 0 ? '—' : p.waiting}</td>
                      {/* Null and zero are different answers: zero is level as
                          of the last handshake, null is a till that has never
                          said, which is one on an older build. */}
                      <td className="num">{p.behind === null ? '?' : p.behind === 0 ? '—' : p.behind}</td>
                      <td>
                        {/* A till that agreed at four and has been unreachable
                            since five past looks, at a glance, exactly like one
                            that agreed at four and had nothing to say after. */}
                        {/* Restored from a backup: the secret was left out of it on
                            purpose, so this till has to be let in again. */}
                        {p.needsPairing
                          ? <span className="badge warn" title="Press Add a till on the other counter, then join it from here">pair again</span>
                          : p.lastError === null
                          ? <span className="badge ok">talking</span>
                          : (
                            <span title={p.lastError}>
                              {/* Answering and refusing is not "not answering":
                                  that sends somebody to check a network that works. */}
                              <span className={looksLikeARefusal(p.lastError) ? 'badge warn' : 'badge'}>
                                {isVersionGap(p.lastError) ? 'needs update'
                                  : looksLikeARefusal(p.lastError) ? 'refused' : 'not answering'}
                              </span>
                              <span style={{ fontSize: 12, color: 'var(--ink-3)', marginLeft: 7 }}>
                                last agreed {ago(p.lastAgreedAt)}
                              </span>
                            </span>
                          )}
                      </td>
                      <td className="r">
                        {role === 'main' && !p.needsPairing && (
                          <button className="btn ghost sm" onClick={() => void handOver(p)}>
                            Make this the main
                          </button>
                        )}
                        <button className="btn ghost sm" onClick={() => void forget(p)}>
                          This till is gone
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              className="btn sm"
              style={{ marginTop: 10 }}
              disabled={busy}
              onClick={() => void syncNow()}
            >
              {busy ? 'Catching up…' : 'Catch up now'}
            </button>
          </section>
        )}

        {/* Above the conflicts, because the two are not the same size of
            problem. A conflict is a decision this till made and a person may
            want to know about. This is a row the other till has and this one
            does not, and it stays that way until somebody acts. */}
        {refused.length > 0 && (
          <Alert>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 4, flex: 1 }}>
                {explainQuarantine(refused.length)}
              </div>
              <button className="link-btn" onClick={() => void dismissRefused()}>
                I have seen these
              </button>
            </div>
            {/* The constraint is the whole diagnosis, so it is shown rather
                than softened into a sentence that could fit any of them. Most
                are two rows created on two tills for one real thing, and the
                fix is to merge or rename them here. */}
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
              {refused.slice(0, 10).map((r) => (
                <li key={r.id}>
                  <strong>{r.table}</strong> — {r.reason}{' '}
                  <span style={{ color: 'var(--ink-3)' }}>({ago(r.at)})</span>
                </li>
              ))}
            </ul>
          </Alert>
        )}

        {conflicts.length > 0 && (
          <Alert kind="warn">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 4, flex: 1 }}>
                {conflicts.length} {conflicts.length === 1 ? 'thing was' : 'things were'} changed
                on both tills, so one of the two changes was dropped.
              </div>
              <button className="link-btn" onClick={() => void dismissConflicts()}>
                I have seen these
              </button>
            </div>
            {/* Nothing retries these and nothing repairs them. The only thing to
                be done is for a person to look and decide whether it mattered,
                which is why they are listed rather than counted. */}
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
              {conflicts.slice(0, 10).map((c) => (
                <li key={c.id}>
                  <strong>{c.table}</strong> — {c.explain}{' '}
                  <span style={{ color: 'var(--ink-3)' }}>({ago(c.at)})</span>
                </li>
              ))}
            </ul>
          </Alert>
        )}
      </div>
    </Card>
  )
}


/**
 * "four minutes ago", not a timestamp.
 *
 * The question being asked is "is this working", and a clock time makes a person
 * do the subtraction themselves — at a counter, mid-queue, which is where they
 * will get it wrong or not bother.
 */
