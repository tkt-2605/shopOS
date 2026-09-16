import { useState } from 'react'
import { changePassword } from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Field, Alert } from './components'

/**
 * Changing your own password.
 *
 * `changePassword` has been in `auth.ts` since v1, checked the current password
 * before accepting a new one, cleared the lockout, wrote an audit row and told
 * nobody about the hash — and had no caller. The only way a cashier's password
 * could change was for an owner to reset it from the Staff screen, which means
 * the owner has to be there, and means the new password is a thing the owner
 * knows. A password somebody else chose for you is not a password.
 *
 * Here rather than on Settings, because Settings is behind the owner's gate and
 * this is the one thing on that screen a cashier needs and an owner should not
 * be asked for.
 */
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const { db } = useCore()
  const user = useUser()

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  async function save() {
    setError(null)

    /* Checked here and not in the service, because it is not a fact about the
       password: the service is told one new password and has nothing to compare
       it against. A typo in a field nobody can read back is worth catching. */
    if (next !== again) {
      setError('The two new passwords do not match.')
      return
    }

    setBusy(true)
    const result = await changePassword(db, {
      userId: user.id,
      currentPassword: current,
      newPassword: next,
    })
    setBusy(false)

    if (!result.ok) {
      setError(
        result.code === 'WRONG_PASSWORD'
          // Not "that user does not exist", which is the other thing this code
          // covers and is not a sentence to show somebody who is signed in.
          ? 'That is not the current password.'
          : `That password will not do: ${result.reason}`,
      )
      return
    }

    setDone(true)
  }

  return (
    <Modal
      title="Change my password"
      onClose={onClose}
      footer={
        done
          ? <button className="btn primary" onClick={onClose}>Close</button>
          : (
            <>
              <button className="btn" onClick={onClose}>Cancel</button>
              <span style={{ flex: 1 }} />
              <button
                className="btn primary"
                disabled={busy || current === '' || next === ''}
                onClick={() => void save()}
              >
                {busy ? 'Changing…' : 'Change it'}
              </button>
            </>
          )
      }
    >
      {done ? (
        <Alert kind="ok">
          Changed. It is the password for this shop on every till — the tills
          share one set of people.
        </Alert>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {error && <Alert>{error}</Alert>}

          <Field label="Current password">
            <input
              className="input" type="password" autoFocus value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="New password">
            <input
              className="input" type="password" value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="New password again">
            <input
              className="input" type="password" value={again}
              onChange={(e) => setAgain(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
            />
          </Field>

          <div style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>
            Signing in stays as it is until you use the new one — nothing signs
            you out. If you forget it, an owner can set a new one from Staff.
          </div>
        </div>
      )}
    </Modal>
  )
}
