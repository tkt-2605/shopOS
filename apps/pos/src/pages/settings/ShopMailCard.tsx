import { useEffect, useState } from 'react'
import { deviceSetting, setDeviceSetting } from '../../core/device'
import { MAIL_PASSWORD, MAIL_USER, destinations, sendTestMail, type Destinations } from '../../core/reportOut'
import { Alert, Card, Field } from '../../ui/components'

/**
 * The shop's email login: the one thing about sending the shop sets up.
 *
 * It sends the daily reports to the shop's own address and, on the main till,
 * every bill for a customer ticked for them. A setting of this computer, never
 * of the shop: the password must not reach the shop's database, which is
 * copied to every till and into every backup. The server and anywhere else the
 * reports go come with the build (`report_out.rs`).
 */
export function ShopMailCard({ shopEmail }: { shopEmail: string | null }) {
  const [user, setUser] = useState(() => deviceSetting(MAIL_USER) ?? '')
  /* Only what is typed here. A saved password is never sent back to this
     screen -- Rust keeps it sealed and shows it as `(saved)` -- so an empty
     box with one saved means "keep it". */
  const [password, setPassword] = useState('')
  const [where, setWhere] = useState<Destinations | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    let live = true
    void destinations().then((d) => { if (live) setWhere(d) }, () => undefined)
    return () => { live = false }
  }, [round])

  const savedUser = deviceSetting(MAIL_USER) ?? ''
  const hasPassword = deviceSetting(MAIL_PASSWORD) !== null
  const changed = user.trim() !== savedUser || password.trim() !== ''

  async function save(): Promise<void> {
    await setDeviceSetting(MAIL_USER, user.trim() === '' ? null : user.trim())
    /* No address is no login: the password goes with it. */
    if (user.trim() === '') await setDeviceSetting(MAIL_PASSWORD, null)
    else if (password.trim() !== '') await setDeviceSetting(MAIL_PASSWORD, password.trim())
    setPassword('')
    setRound((r) => r + 1)
  }

  async function saveAndTest() {
    setBusy(true)
    setNote(null)
    try {
      await save()
      const to = await sendTestMail()
      setNote({ ok: true, text: `Sent. Look for “ShopOS can send from this address” in ${to}.` })
    } catch (err) {
      setNote({ ok: false, text: typeof err === 'string' ? err : err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  async function saveOnly() {
    setBusy(true)
    setNote(null)
    try {
      await save()
      setNote({ ok: true, text: 'Saved.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Shop email"
      actions={<>
        <button className="btn sm" disabled={busy || !changed} onClick={() => void saveOnly()}>Save</button>
        <button className="btn primary sm" disabled={busy || user.trim() === '' || (password.trim() === '' && !hasPassword)}
          onClick={() => void saveAndTest()}>
          {busy ? 'Sending…' : 'Save and send a test'}
        </button>
      </>}
    >
      <div style={{ marginBottom: 11 }}><MailStatus where={where} /></div>
      <div className="settings-grid">
        <Field label="Gmail address" hint="Reports come to this address, and customers’ bills are sent from it.">
          <input
            className="input" id="mail-user" type="text" value={user} autoComplete="off"
            placeholder={shopEmail ?? 'shop@gmail.com'}
            onChange={(e) => { setUser(e.target.value); setNote(null) }}
          />
        </Field>
        <Field
          label="App password"
          hint="Not the Gmail password: Google account, Security, 2-Step Verification, App passwords."
        >
          <input
            className="input" id="mail-password" type="password" value={password} autoComplete="off"
            placeholder={hasPassword ? 'Saved. Type a new one to change it.' : ''}
            onChange={(e) => { setPassword(e.target.value); setNote(null) }}
          />
        </Field>
      </div>
      {note && <div style={{ marginTop: 11 }}><Alert kind={note.ok ? 'ok' : 'bad'}>{note.text}</Alert></div>}
      <div className="settings-group-why" style={{ marginTop: 11 }}>
        Kept on this computer only. Set it on the main till for customers’ bills to be emailed.
      </div>
    </Card>
  )
}

/** One line: ready, not set up, or what is wrong. */
export function MailStatus({ where }: { where: Destinations | null }) {
  if (where === null) return null
  if (where.mailError) return <span className="badge bad">Not working: {where.mailError}</span>
  if (where.sender === null) return <span className="badge warn">Not set up — no reports or bills are emailed</span>
  return <span className="badge ok">Sending as {where.sender}</span>
}
