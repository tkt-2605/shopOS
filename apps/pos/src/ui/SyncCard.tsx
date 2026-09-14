import { useCallback, useEffect, useState } from 'react'
import {
  syncUntilDone, httpTransport, pairWith, pairedPeers, listPeers,
  offerPairing, withdrawPairing, pruneAcknowledged,
  SyncHttpError, getSetting, type ContestedChange,
} from '@shopos/core'
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
  const [peers, setPeers] = useState<Array<{ deviceId: string; label: string | null; lastAgreedAt: string | null }>>([])
  const [joining, setJoining] = useState({ address: '', code: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [contested, setContested] = useState<ContestedChange[]>([])
  const [found, setFound] = useState<FoundTill[] | null>(null)
  const [looking, setLooking] = useState(false)
  /* Which shop this is, so a till already in this shop is not offered back to
     itself, and so two shops on one network are told apart. */
  const [shopId, setShopId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setServing(await servingOn())
    setPeers(await listPeers(db))
    setShopId(await getSetting(db, 'shop_id'))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])

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
      const outcome = await pairWith(db, url, joining.code, null)
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

  async function syncNow() {
    setError(null)
    setBusy(true)
    setContested([])
    try {
      const found: ContestedChange[] = []
      for (const peer of await pairedPeers(db)) {
        const round = await syncUntilDone(db, httpTransport(peer))
        if (!round.ok) {
          setError(explainRefusal(round.code))
          continue
        }
        found.push(...round.contested)
      }
      // Only what every till has confirmed having. A change dropped early is one
      // a switched-off till never learns about.
      await pruneAcknowledged(db)
      setContested(found)
      if (found.length === 0) setNotice('Both tills agree.')
      await refresh()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
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
                <thead><tr><th>Till</th><th>Last agreed</th></tr></thead>
                <tbody>
                  {peers.map((p) => (
                    <tr key={p.deviceId}>
                      <td>{p.label ?? p.deviceId.slice(0, 8)}</td>
                      <td>{p.lastAgreedAt ? new Date(p.lastAgreedAt).toLocaleString() : 'never'}</td>
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

        {contested.length > 0 && (
          <Alert kind="warn">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {contested.length} {contested.length === 1 ? 'thing was' : 'things were'} changed
              on both tills, so one change was dropped.
            </div>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
              {contested.slice(0, 10).map((c) => (
                <li key={`${c.table}/${c.rowId}`}>{c.table} — {c.explain}</li>
              ))}
            </ul>
          </Alert>
        )}
      </div>
    </Card>
  )
}

function explainRefusal(code: string): string {
  switch (code) {
    case 'SCHEMA_MISMATCH':
      return 'The two tills are running different versions of ShopOS. Update them both '
        + 'before they exchange anything — this is refused rather than risked, because '
        + 'a half-understood row is worse than no row.'
    case 'DIFFERENT_SHOP':
      return 'That till has a shop of its own. Two tills set up separately cannot be '
        + 'merged: each has its own staff, counters and price list under the same names. '
        + 'A second till has to be installed and left unset-up, then joined to this one.'
    case 'NO_IDENTITY':
      return 'This machine could not record which machine it is, so it cannot be told '
        + 'apart from the other till. See the banner at the top of the screen.'
    case 'SAME_DEVICE':
      return 'That address is this same till.'
    default:
      return `The other till refused: ${code}.`
  }
}

function explain(err: unknown): string {
  if (err instanceof SyncHttpError) {
    switch (err.code) {
      case 'WRONG_CODE':
        return 'That code was not right. One attempt uses a code up, so show a fresh '
          + 'one on the other till and try again.'
      case 'NO_PAIRING_OFFERED':
        return 'The other till is not offering a code. Press "Show a pairing code" there first.'
      case 'UNKNOWN_PEER':
        return 'The other till does not know this one. Pair them again.'
      case 'BAD_SIGNATURE':
        return 'The other till would not accept this one. Pair them again.'
      default:
        return explainRefusal(err.code)
    }
  }
  return 'Could not reach that till. Check the address, and that it is switched on and '
    + `answering. ${String(err)}`
}
