import { useCallback, useEffect, useState } from 'react'
import {
  listStaff, createUser, updateUser, resetPassword, unlockUser, setUserActive,
  listRoles, wouldLeaveNoAdministrator, type StaffMember, type RoleSummary,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Card, Modal, Field, Empty, Alert } from '../ui/components'

interface NewStaff {
  username: string
  fullName: string
  roleId: string
  password: string
}

const LOCKED_OUT = 'That would leave nobody able to administer the shop. Give someone else an administrator role first.'

export default function Staff() {
  const { db } = useCore()
  const me = useUser()
  const [rows, setRows] = useState<StaffMember[]>([])
  const [roles, setRoles] = useState<RoleSummary[]>([])
  const [adding, setAdding] = useState<NewStaff | null>(null)
  const [editing, setEditing] = useState<StaffMember | null>(null)
  const [resetting, setResetting] = useState<{ member: StaffMember; password: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRows(await listStaff(db))
    setRoles(await listRoles(db))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])

  function say(message: string) {
    setNotice(message)
    setTimeout(() => setNotice(null), 3500)
  }

  async function add() {
    if (!adding) return
    setError(null)
    const result = await createUser(db, {
      username: adding.username,
      password: adding.password,
      ...(adding.fullName.trim() ? { fullName: adding.fullName.trim() } : {}),
      roleId: adding.roleId,
      actorId: me.id,
    })
    if (!result.ok) {
      setError(result.code === 'USERNAME_TAKEN' ? 'That username is already in use.' : result.reason)
      return
    }
    setAdding(null)
    await refresh()
    say(`${adding.username} can now sign in.`)
  }

  async function saveEdit() {
    if (!editing) return
    setError(null)
    if (await wouldLeaveNoAdministrator(db, { userId: editing.id, roleId: editing.roleId })) {
      setError(LOCKED_OUT)
      return
    }
    await updateUser(db, {
      userId: editing.id, fullName: editing.fullName, roleId: editing.roleId, actorId: me.id,
    })
    setEditing(null)
    await refresh()
    say('Saved.')
  }

  async function doReset() {
    if (!resetting) return
    setError(null)
    const result = await resetPassword(db, {
      userId: resetting.member.id, newPassword: resetting.password, actorId: me.id,
    })
    if (!result.ok) { setError(result.code === 'WEAK_PASSWORD' ? result.reason : 'That did not work.'); return }
    const who = resetting.member.username
    setResetting(null)
    await refresh()
    say(`${who} can now sign in with the new password.`)
  }

  async function toggleActive(member: StaffMember) {
    setError(null)
    if (member.isActive && await wouldLeaveNoAdministrator(db, { userId: member.id, isActive: false })) {
      setError(LOCKED_OUT)
      return
    }
    await setUserActive(db, { userId: member.id, isActive: !member.isActive, actorId: me.id })
    await refresh()
  }

  async function unlock(member: StaffMember) {
    await unlockUser(db, { userId: member.id, actorId: me.id })
    await refresh()
    say(`${member.username} can try signing in again.`)
  }

  const now = new Date().toISOString()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 980 }}>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      <Card
        title="Staff"
        actions={
          <button
            className="btn primary sm"
            disabled={roles.length === 0}
            onClick={() => setAdding({ username: '', fullName: '', roleId: roles[0]?.id ?? '', password: '' })}
          >
            Add someone
          </button>
        }
      >
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
          What each person can see and do comes from their role, not from this screen.
          An account is switched off rather than deleted, so the bills they raised keep their name.
        </div>

        <div className="card card-scroll">
          <table>
            <thead>
              <tr>
                <th>Username</th><th>Name</th><th>Role</th><th>Last signed in</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const locked = m.lockedUntil !== null && m.lockedUntil > now
                return (
                  <tr key={m.id}>
                    <td className="num">
                      {m.username}
                      {m.id === me.id && <span className="badge mute" style={{ marginLeft: 7 }}>you</span>}
                    </td>
                    <td>{m.fullName ?? <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
                    <td>{m.roleName}</td>
                    <td style={{ color: 'var(--ink-3)' }}>{formatWhen(m.lastLoginAt)}</td>
                    <td>
                      {!m.isActive
                        ? <span className="badge mute">off</span>
                        : locked
                          ? <span className="badge warn">locked</span>
                          : <span className="badge ok">active</span>}
                    </td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      {locked && <button className="btn ghost sm" onClick={() => void unlock(m)}>Unlock</button>}
                      <button className="btn ghost sm" onClick={() => setEditing({ ...m })}>Edit</button>
                      <button className="btn ghost sm" onClick={() => setResetting({ member: m, password: '' })}>
                        Reset password
                      </button>
                      <button className="btn ghost sm" onClick={() => void toggleActive(m)}>
                        {m.isActive ? 'Switch off' : 'Switch on'}
                      </button>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && <tr><td colSpan={6}><Empty>No staff yet</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {adding && (
        <Modal
          title="Add someone"
          onClose={() => setAdding(null)}
          footer={<>
            <button className="btn" onClick={() => setAdding(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={adding.username.trim() === '' || adding.password.length < 6}
              onClick={() => void add()}
            >
              Create
            </button>
          </>}
        >
          <Field label="Username" hint="What they type to sign in. Lower case, no spaces.">
            <input className="input" id="staff-username" autoFocus value={adding.username}
              onChange={(e) => setAdding({ ...adding, username: e.target.value.replace(/\s/g, '').toLowerCase() })} />
          </Field>
          <Field label="Full name">
            <input className="input" id="staff-name" value={adding.fullName}
              onChange={(e) => setAdding({ ...adding, fullName: e.target.value })} placeholder="Optional" />
          </Field>
          <Field label="Role">
            <select className="select" id="staff-role" value={adding.roleId}
              onChange={(e) => setAdding({ ...adding, roleId: e.target.value })}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Password" hint="At least 6 characters, and not only digits. They can change it later.">
            <input className="input" id="staff-password" type="password" value={adding.password}
              onChange={(e) => setAdding({ ...adding, password: e.target.value })} />
          </Field>
        </Modal>
      )}

      {editing && (
        <Modal
          title={`Edit ${editing.username}`}
          onClose={() => setEditing(null)}
          footer={<>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={() => void saveEdit()}>Save</button>
          </>}
        >
          <Field label="Full name">
            <input className="input" id="edit-name" autoFocus value={editing.fullName ?? ''}
              onChange={(e) => setEditing({ ...editing, fullName: e.target.value })} />
          </Field>
          <Field label="Role">
            <select className="select" id="edit-role" value={editing.roleId}
              onChange={(e) => setEditing({ ...editing, roleId: e.target.value })}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          {editing.id === me.id && (
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              Changing your own role takes effect the next time you sign in.
            </div>
          )}
        </Modal>
      )}

      {resetting && (
        <Modal
          title={`Reset ${resetting.member.username}'s password`}
          onClose={() => setResetting(null)}
          footer={<>
            <button className="btn" onClick={() => setResetting(null)}>Cancel</button>
            <button className="btn primary" disabled={resetting.password.length < 6} onClick={() => void doReset()}>
              Reset
            </button>
          </>}
        >
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
            You are setting this password directly, without knowing the old one. The change is
            recorded against your name in the audit trail.
          </div>
          <Field label="New password">
            <input className="input" id="reset-password" type="password" autoFocus value={resetting.password}
              onChange={(e) => setResetting({ ...resetting, password: e.target.value })} />
          </Field>
        </Modal>
      )}
    </div>
  )
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Never'

  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days === 0) return `Today, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}
