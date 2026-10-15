import { useState } from 'react'
import { applyPack, checkPack, reauthenticate, type PackCheck, type RepairPreview } from '@shopos/core'
import { useCore, useUser } from '../../core/CoreProvider'
import { takeBackupNow } from '../../core/backup'
import { Card, Field, Alert } from '../../ui/components'

/**
 * A fix from support, applied by the owner.
 *
 * Support sends a repair pack -- text, by WhatsApp or as a file -- instead of
 * typing into the shop's database over a remote session. This card says what
 * it will do in words before anything changes, refuses one that is not from
 * ShopOS, not for this shop, out of date or already used, and when the owner
 * agrees: asks for the password again, takes a backup, applies it, and says
 * what was done. Every repair is in the audit, naming the support case.
 */
export function ApplyFixCard() {
  const { db, reloadRegister } = useCore()
  const user = useUser()
  const [raw, setRaw] = useState('')
  const [checked, setChecked] = useState<PackCheck | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<RepairPreview[] | null>(null)

  async function check() {
    setError(null)
    setDone(null)
    setChecked(await checkPack(db, raw))
  }

  async function apply() {
    setError(null)
    const ok = await reauthenticate(db, { userId: user.id, password, scope: 'repair_pack' })
    if (!ok.ok) {
      setError('That is not your password.')
      return
    }
    try {
      setBusy('Taking a backup first.')
      await takeBackupNow(db)
    } catch (e) {
      setBusy(null)
      setError(`Nothing was changed: the backup before it could not be taken (${e instanceof Error ? e.message : String(e)}).`)
      return
    }
    setBusy('Applying the fix.')
    const result = await applyPack(db, { raw, actorId: user.id })
    setBusy(null)
    if (result.ok) {
      setDone(result.done)
      setChecked(null)
      setRaw('')
      setPassword('')
      // A counter let go is one this machine may now take without a restart.
      await reloadRegister().catch(() => {})
    } else {
      setDone(result.done ?? null)
      setError(result.detail)
    }
  }

  return (
    <Card title="Apply a fix from support">
      <p className="settings-group-why" style={{ marginTop: 0 }}>
        When support finds what is wrong, they send a fix as a block of text. Paste it here. You will
        see what it does before anything changes, and a backup is taken before it is applied. A fix
        only works in the shop it was made for, and only once.
      </p>
      <Field label="The fix support sent">
        <textarea className="input" rows={3} value={raw} spellCheck={false}
          onChange={(e) => { setRaw(e.target.value); setChecked(null) }} />
      </Field>
      {checked === null && (
        <div style={{ marginTop: 8 }}>
          <button className="btn sm" disabled={raw.trim() === ''} onClick={() => void check()}>Check it</button>
        </div>
      )}

      {checked !== null && !checked.ok && (
        <Alert>
          {checked.detail}
          {checked.previews && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {checked.previews.filter((p) => p.problem).map((p, i) => <li key={i}>{p.says} {p.problem}</li>)}
            </ul>
          )}
        </Alert>
      )}

      {checked?.ok && (
        <div style={{ marginTop: 10 }}>
          <div className="settings-option-note">Support case: {checked.pack.ticket}</div>
          <div className="settings-option-note">Valid until {new Date(checked.pack.expiresAt).toLocaleString('en-IN')}</div>
          <p style={{ margin: '8px 0 4px' }}>This fix will:</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {checked.previews.map((p, i) => <li key={i}>{p.says}</li>)}
          </ul>
          <Field label="Your password">
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn primary sm" disabled={busy !== null || password === ''} onClick={() => void apply()}>
              Apply it
            </button>
            <button className="btn ghost sm" disabled={busy !== null} onClick={() => setChecked(null)}>Not now</button>
          </div>
        </div>
      )}

      {busy && <Alert kind="warn">{busy}</Alert>}
      {error && <Alert>{error}</Alert>}
      {done && done.length > 0 && (
        <Alert kind={error ? 'warn' : 'ok'}>
          {error ? 'Done before it stopped:' : 'Done:'}
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {done.map((p, i) => <li key={i}>{p.says}</li>)}
          </ul>
        </Alert>
      )}
    </Card>
  )
}
