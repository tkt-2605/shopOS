import { useState } from 'react'
import { login } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { Field, Alert } from '../ui/components'
import { Recover } from './Recover'

/* Staff sign in here with a username and a password, offline. */

export function Login() {
  const { db, setUser } = useCore()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recovering, setRecovering] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const result = await login(db, { username, password })
    setBusy(false)

    if (result.ok) {
      setUser(result.user)
      return
    }
    setError(
      result.code === 'ACCOUNT_DISABLED'
        ? 'This account has been turned off.'
        : 'That username and password do not match.',
    )
  }

  if (recovering) return <Recover onBack={() => { setRecovering(false); setPassword(''); setError(null) }} />

  return (
    <div className="centre">
      <form className="panel" onSubmit={(e) => void submit(e)}>
        <div className="panel-head">
          <h1>ShopOS</h1>
          <p>Sign in to the counter</p>
        </div>
        <div className="panel-body">
          {error && <Alert>{error}</Alert>}
          <Field label="Username">
            <input className="input" id="username" value={username} autoFocus onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="Password">
            <input className="input" id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <button className="btn primary lg" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="link-btn" id="forgot-password" onClick={() => setRecovering(true)}>
            Forgot password?
          </button>
        </div>
      </form>
    </div>
  )
}
