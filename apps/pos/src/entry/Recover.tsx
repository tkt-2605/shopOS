import { useState } from 'react'
import { recoverWithCode } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { Field, Alert } from '../ui/components'
import { RecoveryCodeShown } from '../ui/RecoveryCode'

/*
 * A forgotten password, set again with the shop's recovery code. Offline, like
 * signing in. Using the code replaces it, so the new one is shown before the
 * person goes back to sign in.
 */

const REFUSED = {
  NO_CODE: 'This shop has no recovery code. Another administrator can reset the password from Staff.',
  WRONG_CODE: 'That is not the recovery code. Check it against the paper; a newer one may have been made since.',
  NO_SUCH_USER: 'There is no account switched on with that username.',
} as const

export function Recover({ onBack }: { onBack: () => void }) {
  const { db } = useCore()
  const [code, setCode] = useState('')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newCode, setNewCode] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== again) { setError('The two passwords are not the same.'); return }
    setBusy(true)
    setError(null)
    const result = await recoverWithCode(db, { code, username, newPassword: password })
    setBusy(false)
    if (result.ok) { setNewCode(result.newCode); return }
    setError(result.code === 'WEAK_PASSWORD' ? result.reason : REFUSED[result.code])
  }

  if (newCode) {
    return (
      <div className="centre">
        <div className="panel">
          <div className="panel-head">
            <h1>Password set</h1>
            <p>The old recovery code is used up. This is the new one.</p>
          </div>
          <div className="panel-body">
            <RecoveryCodeShown code={newCode} doneLabel="Back to sign in" onDone={onBack} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="centre">
      <form className="panel" onSubmit={(e) => void submit(e)}>
        <div className="panel-head">
          <h1>Forgot password</h1>
          <p>Use the recovery code written down when the shop was set up.</p>
        </div>
        <div className="panel-body">
          {error && <Alert>{error}</Alert>}
          <Field label="Recovery code">
            <input
              className="input mono" id="recovery-code-input" value={code} autoFocus
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX" onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Field label="Username">
            <input className="input" id="recover-username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 6 characters.">
            <input className="input" id="recover-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="New password again">
            <input className="input" id="recover-again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary lg" disabled={busy || !code.trim() || password.length < 6}>
              {busy ? 'Checking…' : 'Set password'}
            </button>
            <button type="button" className="btn ghost" onClick={onBack}>Back</button>
          </div>
        </div>
      </form>
    </div>
  )
}
