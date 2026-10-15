import { useEffect, useState } from 'react'
import { getSetting, reauthenticate, noteDataForSupport } from '@shopos/core'
import { useCore, useUser } from '../../core/CoreProvider'
import { chooseFolder } from '../../core/backup'
import {
  supportDataReady, makeSupportData, sendSupportData, saveSupportData, discardSupportData, size, type Made,
} from '../../core/supportData'
import { Card, Field, Alert } from '../../ui/components'

/**
 * The shop's data, to support, when the owner decides.
 *
 * On Settings → Help, behind the owner's gate, and asking for the password
 * again: this sends the whole shop's books out of the building. The card says
 * what goes, who can open it and when it is deleted before anything is made,
 * because those are the three questions an owner should ask and is owed the
 * answer to without asking.
 */
export function SendDataCard() {
  const { db } = useCore()
  const user = useUser()
  const [ready, setReady] = useState<boolean | null>(null)
  const [anonymise, setAnonymise] = useState(true)
  const [note, setNote] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [made, setMade] = useState<Made | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void supportDataReady().then(setReady) }, [])

  async function make(): Promise<Made | null> {
    if (made) return made
    const checked = await reauthenticate(db, { userId: user.id, password, scope: 'support_data' })
    if (!checked.ok) {
      setError('That is not your password.')
      return null
    }
    const shopId = await getSetting(db, 'shop_id')
    if (!shopId) {
      setError('This till has no shop yet, so there is nothing to send.')
      return null
    }
    setBusy('Packing the data. Passwords come out first' + (anonymise ? ', and the customers.' : '.'))
    const fresh = await makeSupportData({ shopId, madeBy: user.username, note: note.trim(), anonymise })
    await noteDataForSupport(db, { actorId: user.id, fileId: fresh.id, anonymised: anonymise, bytes: fresh.bytes })
    setMade(fresh)
    return fresh
  }

  async function act(how: 'send' | 'save') {
    setError(null)
    setDone(null)
    try {
      const file = await make()
      if (!file) return
      if (how === 'save') {
        const folder = await chooseFolder()
        if (!folder) return
        const path = await saveSupportData(file.id, folder)
        setDone(`Saved to ${path}. Send that file to support by WhatsApp or email; only support can open it.`)
        return
      }
      setBusy(`Sending ${size(file.bytes)}. On a slow line this can take a few minutes; billing carries on.`)
      const sent = await sendSupportData(file.id)
      if (sent.done) {
        setMade(null)
        setPassword('')
        setDone('Sent. Support has it, and it is deleted from their server 30 days from now.')
      } else {
        setError(`It stopped part of the way: ${sent.error ?? 'no answer'}. Press Send again to carry on from there, or save it to a file instead.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function throwAway() {
    if (made) await discardSupportData(made.id).catch(() => {})
    setMade(null)
    setError(null)
  }

  if (ready === false) {
    return (
      <Card title="Send my data to support">
        <Alert kind="warn">
          This copy of ShopOS cannot send data to support: it was built without the support key.
          Save a report above instead, or ask for an updated copy.
        </Alert>
      </Card>
    )
  }

  return (
    <Card title="Send my data to support">
      <p className="settings-group-why" style={{ marginTop: 0 }}>
        Sends this shop&rsquo;s records to ShopOS support, so they can see what went wrong rather than
        guess. It is locked before it leaves this machine so that only ShopOS support can open it &mdash;
        not the server it passes through, and not anybody who intercepts it. Passwords and the recovery
        code are taken out first. Support&rsquo;s copy is deleted 30 days after it arrives.
      </p>

      <label className="settings-option" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '10px 0' }}>
        <input type="checkbox" checked={anonymise} disabled={made !== null}
          onChange={(e) => setAnonymise(e.target.checked)} />
        <span>
          Leave out customer details
          <span className="settings-option-note" style={{ display: 'block' }}>
            Names, phone numbers, emails, GSTINs and addresses are replaced, the same way for the same
            customer, so the accounts still add up. Notes staff typed on bills stay as they are.
          </span>
        </span>
      </label>

      <Field label="What happened? (optional)">
        <textarea className="input" rows={2} value={note} disabled={made !== null}
          onChange={(e) => setNote(e.target.value)} />
      </Field>
      {made === null && (
        <Field label="Your password">
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      )}

      {busy && <Alert kind="warn">{busy}</Alert>}
      {error && <Alert>{error}</Alert>}
      {done && <Alert kind="ok">{done}</Alert>}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn primary sm" disabled={busy !== null || (made === null && password === '')}
          onClick={() => void act('send')}>
          {made ? 'Send again' : 'Send to support'}
        </button>
        <button className="btn sm" disabled={busy !== null || (made === null && password === '')}
          onClick={() => void act('save')}>
          Save to a file instead…
        </button>
        {made && <button className="btn ghost sm" disabled={busy !== null} onClick={() => void throwAway()}>Throw it away</button>}
      </div>
    </Card>
  )
}
