import { useCallback, useEffect, useState } from 'react'
import {
  pairWith, listPeers,
  offerPairing, withdrawPairing,
  recentConflicts, acknowledgeConflicts,
  getSetting,
  type PeerHealth, type RecordedConflict,
} from '@shopos/core'
import { runOnce, onSyncRound } from '../core/syncLoop'
import { syncNotice } from '../core/syncNotice'
import { explain, explainRefusal } from '../core/syncWords'
import {
  startServing, stopServing, servingOn, lookAround,
  type ServeInfo, type FoundTill,
} from '../core/syncHost'
import { useCore } from '../core/CoreProvider'
import { Card, Field, Alert } from './components'

/**
 * Two tills in one shop.
 *
 * The screen is two halves because setting it up is two jobs done on two
 * machines, and confusing them is how somebody ends up pairing a till with
 * itself. The till that already has the shop **shows a code**; the new till
 * **types one in**. Nothing here lets a till do both at once.
 *
 * Off until a shop asks for it. A single till never opens a port, which is most
 * shops — a port nothing uses is a way in and no use to anybody.
 */

export function SyncCard() {
  const { db, shop } = useCore()
  const [serving, setServing] = useState<ServeInfo | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [peers, setPeers] = useState<PeerHealth[]>([])
  const [conflicts, setConflicts] = useState<RecordedConflict[]>([])
  const [joining, setJoining] = useState({ address: '', code: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [found, setFound] = useState<FoundTill[] | null>(null)
  const [looking, setLooking] = useState(false)
  /* Which shop this is, so a till already in this shop is not offered back to
     itself, and so two shops on one network are told apart. */
  const [shopId, setShopId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setServing(await servingOn())
    setPeers(await listPeers(db))
    setConflicts(await recentConflicts(db, { limit: 20 }))
    setShopId(await getSetting(db, 'shop_id'))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])

  /* The catch-up runs whether or not this screen is open, so the screen follows
     it rather than keeping its own idea of when the tills last agreed. */
  useEffect(() => {
    onSyncRound(() => { void refresh() })
    return () => onSyncRound(null)
  }, [refresh])

  // A code that lapses on the Rust side should stop being shown here too.
  useEffect(() => {
    if (code === null) return
    const timer = setTimeout(() => setCode(null), 10 * 60 * 1000)
    return () => clearTimeout(timer)
  }, [code])

  async function toggleServing() {
    setError(null)
    try {
      if (serving) {
        withdrawPairing()
        setCode(null)
        await stopServing()
      } else {
        await startServing(db, 7801, { name: shop.name, id: shopId })
      }
      await refresh()
    } catch (err) {
      setError(
        'This machine could not open the port other tills knock on. '
        + 'Another program may already be using it, or Windows may be blocking it. '
        + String(err),
      )
    }
  }

  function showCode() {
    setCode(offerPairing())
  }

  /**
   * Asks the network rather than asking the shopkeeper.
   *
   * Nobody should have to read 192.168.1.11 off one screen and type it into
   * another, and the address changes whenever the router feels like it — so
   * typing it once turns into a thing that breaks on a Tuesday. A till found
   * here still has to be paired with a code; being findable grants nothing.
   */
  async function findTills() {
    setError(null)
    setLooking(true)
    try {
      const tills = await lookAround()
      // This till answers the shout too, and pairing with itself is refused
      // anyway — but offering it would be a puzzle rather than a choice.
      const others = tills.filter((t) => t.shopId === null || t.shopId !== shopId)
      setFound(others)
      if (others.length === 1) {
        setJoining((was) => ({ ...was, address: others[0]!.address }))
      }
    } catch (err) {
      setError(`Could not look for tills on this network. ${String(err)}`)
    } finally {
      setLooking(false)
    }
  }

  async function join() {
    setError(null)
    setBusy(true)
    try {
      const address = joining.address.trim().replace(/\/+$/, '')
      const url = address.startsWith('http') ? address : `http://${address}`
      /* Telling the other till where to reach us, at the one moment both are
         certainly talking. Without it the shop it is joining records a peer
         with a secret and no address, and could never start a sync back. A
         till that is not yet listening sends nothing and is recorded when it
         first makes a signed request instead. */
      const mine = await servingOn()
      const outcome = await pairWith(
        db, url, joining.code, null, fetch, { listenPort: mine?.port ?? null },
      )
      setJoining({ address: '', code: '' })
      setNotice(`Paired with ${outcome.label ?? outcome.deviceId}. Syncing now.`)
      await syncNow()
      await refresh()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
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

  return (
    <Card title="Two tills">
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
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            This till answers other tills
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => void toggleServing()}>
              {serving ? 'Stop answering' : 'Start answering'}
            </button>
            {serving
              ? (
                <span style={{ fontSize: 12.5 }}>
                  Listening on <strong>{serving.address ?? `port ${serving.port}`}</strong>
                </span>
              )
              : (
                <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                  Closed. Nothing can reach this till.
                </span>
              )}
          </div>

          {serving && (
            <div style={{ marginTop: 10 }}>
              {code === null
                ? (
                  <button className="btn sm" onClick={showCode}>Show a pairing code</button>
                )
                : (
                  <div>
                    <div style={{ fontSize: 24, letterSpacing: 4, fontWeight: 600 }}>{code}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>
                      Type this into the other till, along with the address above. It
                      lasts ten minutes and <strong>one attempt uses it up</strong>,
                      right or wrong — show a fresh one if it is mistyped.
                    </div>
                  </div>
                )}
            </div>
          )}
        </section>

        <section>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            Join a till that already has the shop
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Its address">
              <input
                className="input"
                placeholder="192.168.1.11:7801"
                value={joining.address}
                onChange={(e) => setJoining({ ...joining, address: e.target.value })}
              />
            </Field>
            <button className="btn sm" disabled={looking} onClick={() => void findTills()}>
              {looking ? 'Looking…' : 'Find tills'}
            </button>
            <Field label="The code it is showing">
              <input
                className="input"
                placeholder="ABCD2345"
                style={{ letterSpacing: 2, textTransform: 'uppercase' }}
                value={joining.code}
                onChange={(e) => setJoining({ ...joining, code: e.target.value })}
              />
            </Field>
            <button
              className="btn primary sm"
              disabled={busy || joining.address.trim() === '' || joining.code.trim() === ''}
              onClick={() => void join()}
            >
              Join
            </button>
          </div>
          {found !== null && (
            <div style={{ fontSize: 12.5, marginTop: 8 }}>
              {found.length === 0
                ? 'No other till answered. Check it is switched on and that "Start answering" is pressed on it.'
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {found.map((t) => (
                      <button
                        key={t.device}
                        className="link-btn"
                        style={{ textAlign: 'left' }}
                        onClick={() => setJoining((was) => ({ ...was, address: t.address }))}
                      >
                        {t.shop ?? 'A till'} — {t.label} at {t.address}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          )}

          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6 }}>
            Only on a till that has <em>not</em> been set up with its own shop. A till
            that has already been set up is a second shop, and the two cannot be merged.
          </div>
        </section>

        {peers.length > 0 && (
          <section>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Paired with</div>
            <div className="card">
              <table>
                <thead>
                  <tr><th>Till</th><th>Last agreed</th><th>Waiting</th><th /></tr>
                </thead>
                <tbody>
                  {peers.map((p) => (
                    <tr key={p.deviceId}>
                      <td>{p.label ?? p.deviceId.slice(0, 8)}</td>
                      <td>{ago(p.lastAgreedAt)}</td>
                      <td className="num">{p.waiting === 0 ? '—' : p.waiting}</td>
                      <td>
                        {/* A till that agreed at four and has been unreachable
                            since five past looks, at a glance, exactly like one
                            that agreed at four and had nothing to say after. */}
                        {p.lastError === null
                          ? <span className="badge ok">talking</span>
                          : (
                            <span title={p.lastError}>
                              <span className="badge">not answering</span>
                              <span style={{ fontSize: 12, color: 'var(--ink-3)', marginLeft: 7 }}>
                                last agreed {ago(p.lastAgreedAt)}
                              </span>
                            </span>
                          )}
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
function ago(at: string | null): string {
  if (at === null) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
