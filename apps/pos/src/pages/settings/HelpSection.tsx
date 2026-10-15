import { useEffect, useState } from 'react'
import { getSetting, shortShopId } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { writeDiagnosticsBundle } from '../../core/diagnostics'
import { spokenShop } from '../../core/support'
import { SendDataCard } from './SendDataCard'
import { appVersion, versionLine, shopLine, type AppVersion } from '../../core/version'
import { Card, Alert } from '../../ui/components'
import { Intro } from './parts'

/**
 * One file to send when something has gone wrong, and the version to read out
 * down a phone.
 *
 * The card says plainly that nothing is sent, because a button called
 * "diagnostics" on software sold as offline-first invites exactly that
 * suspicion, and the suspicion would be reasonable.
 */
export function HelpSection() {
  const [busy, setBusy] = useState(false)
  const [written, setWritten] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState<AppVersion | null>(null)
  const { db } = useCore()
  const [shop, setShop] = useState<string | null>(null)

  useEffect(() => { void appVersion().then(setVersion) }, [])
  useEffect(() => {
    void getSetting(db, 'shop_id').then((id) => setShop(id ? shortShopId(id) : null)).catch(() => {})
  }, [db])

  async function make() {
    setBusy(true)
    setError(null)
    setWritten(null)
    try {
      const result = await writeDiagnosticsBundle()
      // A closed folder picker is a decision, not a failure.
      if (!result.ok && result.cancelled) return
      if (!result.ok) setError(result.error)
      else setWritten(result.path)
    } catch (err) {
      setError(`The report could not be written: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Intro>For the day something goes wrong, and for whoever is helping you put it right.</Intro>

      <Card title="This copy of ShopOS">
        <div className="about-line">
          <span className="settings-option-note">Version</span>
          <span className="num">{versionLine(version)}</span>
        </div>
        <div className="about-line">
          <span className="settings-option-note">Support code</span>
          <span className="num">{shop ? spokenShop(shop) : 'no shop yet'}</span>
        </div>
        {version?.shop && (
          <div className="about-line">
            <span className="settings-option-note">Shop on this machine</span>
            <span>{shopLine(version)}</span>
          </div>
        )}
      </Card>

      <Card
        title="Report a problem"
        actions={
          <button className="btn sm" disabled={busy} onClick={() => void make()}>
            {busy ? 'Writing…' : 'Save a report…'}
          </button>
        }
      >
        <p className="settings-group-why" style={{ marginTop: 0 }}>
          Saves one file describing this machine — which version it is running, what its
          database looks like, what the last few hundred things done on it were, and the
          records it keeps of its own errors. Send it to whoever is helping you, by WhatsApp
          or email.
        </p>
        <p className="settings-group-why">
          <strong>ShopOS does not send it anywhere.</strong> It is written to a folder you
          choose and stays on this machine until you attach it to something yourself. Your
          passwords are not in it, and neither is the command set under “Run after each
          backup” — that one can hold a cloud password, so the report says only that it is
          set and how long it is.
        </p>
        {error && <Alert>{error}</Alert>}
        {written && <Alert kind="ok">Saved to {written}</Alert>}
      </Card>

      <SendDataCard />
    </>
  )
}
