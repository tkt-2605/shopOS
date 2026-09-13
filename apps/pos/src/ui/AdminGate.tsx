import { useEffect, useState, type ReactNode } from 'react'
import { reauthenticate } from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { isUnlocked, unlock, lock, onGateChange, unlockRemaining, UNLOCK_MINUTES } from '../core/adminGate'
import { Field, Alert } from './components'

/**
 * The door in front of the two screens that can change everything else.
 *
 * Deliberately not a `Modal`. A dialog exists to interrupt a page that is
 * already there, and the focus trap in `components.tsx` exists to keep the
 * keyboard out of the page behind it — but there is nothing behind this one,
 * because the page is exactly what is being withheld. Showing an empty Settings
 * screen greyed out under a dialog would also be a small leak: which cards
 * exist, and how many, is itself information about the shop.
 *
 * What it asks for is the signed-in person's own password, not a shared PIN. A
 * PIN ends up on a sticky note behind the counter, and the history screen then
 * records that "somebody" changed the tax settings.
 */
export function AdminGate({ scope, title, children }: {
  scope: string
  title: string
  children: ReactNode
}) {
  const { db } = useCore()
  const user = useUser()
  const [open, setOpen] = useState(() => isUnlocked())

  useEffect(() => onGateChange(() => setOpen(isUnlocked())), [])

  /* The unlock lapses on a clock, and nothing else would notice: a screen left
     open on Settings would stay open past its ten minutes because no keystroke
     ever came to re-check. */
  useEffect(() => {
    if (!open) return
    const left = unlockRemaining()
    if (left <= 0) { setOpen(false); return }
    const timer = setTimeout(() => setOpen(isUnlocked()), left + 50)
    return () => clearTimeout(timer)
  }, [open])

  if (open) {
    return (
      <>
        <div className="gate-bar">
          <span>
            Unlocked for {UNLOCK_MINUTES} minutes, as {user.fullName ?? user.username}.
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={() => lock()}>Lock again</button>
        </div>
        {children}
      </>
    )
  }

  return <Ask db={db} scope={scope} title={title} />
}

function Ask({ db, scope, title }: { db: Parameters<typeof reauthenticate>[0]; scope: string; title: string }) {
  const user = useUser()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    const result = await reauthenticate(db, { userId: user.id, password, scope })
    setBusy(false)
    setPassword('')

    if (result.ok) { unlock(); return }

    setError(
      result.code === 'ACCOUNT_LOCKED'
        ? `Too many attempts. This account is locked until ${new Date(result.until).toLocaleTimeString()}.`
        : result.attemptsLeft > 0
          /* Counted down out loud, because the alternative is a cashier
             discovering the lockout by hitting it during a queue. */
          ? `That is not the right password. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left before this account is locked.`
          : 'That is not the right password.',
    )
  }

  return (
    <div className="centre">
      <form className="panel" onSubmit={(e) => void submit(e)}>
        <div className="panel-head">
          <h1>{title}</h1>
          <p>Changing these affects the whole shop, so it asks who you are.</p>
        </div>
        <div className="panel-body">
          {error && <Alert>{error}</Alert>}
          <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
            Signed in as <strong>{user.fullName ?? user.username}</strong> ({user.roleName}).
          </div>
          <Field label="Your password" hint={`Stays unlocked for ${UNLOCK_MINUTES} minutes.`}>
            <input
              className="input" id="gate-password" type="password" autoFocus
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <button className="btn primary lg" disabled={busy || password === ''}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      </form>
    </div>
  )
}
