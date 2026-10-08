import { useCallback, useEffect, useState } from 'react'
import { Permissions, recoveryCodeState, makeRecoveryCode, type RecoveryCodeState } from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { copyText } from '../core/clipboard'
import { Card, Modal, Alert } from './components'
import { useShopChanged } from '../core/useShopChanged'

/*
 * The shop's recovery code, on the two screens that show it: once when the
 * shop is set up, and on Staff when an owner makes a new one. Both show it
 * exactly once -- only its hash is kept, so nothing can show it again.
 */

/** The code, big enough to copy by hand, and a tick before anybody moves on. */
export function RecoveryCodeShown({ code, onDone, doneLabel }: {
  code: string
  onDone: () => void
  doneLabel: string
}) {
  const [kept, setKept] = useState(false)
  const [copied, setCopied] = useState(false)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="recovery-code" id="recovery-code">{code}</div>
      <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
        If the administrator password is ever forgotten, this code sets a new one
        at any counter, with no internet. Write it down and keep it somewhere other
        than the shop. It is shown only now; nobody can look it up later, including us.
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <input type="checkbox" id="recovery-kept" checked={kept} onChange={(e) => setKept(e.target.checked)} />
        I have written it down
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary lg" disabled={!kept} onClick={onDone}>{doneLabel}</button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void copyText(code).then(setCopied)}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

/** On Staff: whether the shop has a code, and making a new one. */
export function RecoveryCodeCard() {
  const { db } = useCore()
  const me = useUser()
  const canWrite = Permissions.can(me.permissions, 'user', 'write')
  const [state, setState] = useState<RecoveryCodeState | null>(null)
  const [asking, setAsking] = useState(false)
  const [shown, setShown] = useState<string | null>(null)

  const refresh = useCallback(async () => { setState(await recoveryCodeState(db)) }, [db])
  useEffect(() => { void refresh() }, [refresh])
  // Another till may make one, and this one's stops working when it arrives.
  useShopChanged(refresh)

  async function make() {
    setAsking(false)
    setShown(await makeRecoveryCode(db, { actorId: me.id }))
    await refresh()
  }

  if (!canWrite || state === null) return null

  return (
    <>
      <Card
        title="Recovery code"
        actions={(
          <button className="btn ghost sm" onClick={() => (state.madeAt ? setAsking(true) : void make())}>
            {state.madeAt ? 'Make a new code' : 'Make a code'}
          </button>
        )}
      >
        {state.madeAt
          ? (
            <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
              Made {new Date(state.madeAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.
              It sets a new password when one is forgotten, from the sign-in screen.
              Make a new one if the paper is lost or somebody else has seen it.
            </div>
          )
          : (
            <Alert kind="warn">
              This shop has no recovery code. If the administrator password is
              forgotten, there is no way back in. Make one and write it down.
            </Alert>
          )}
      </Card>

      {asking && (
        <Modal
          title="Make a new recovery code?"
          onClose={() => setAsking(false)}
          footer={<>
            <button className="btn" onClick={() => setAsking(false)}>Cancel</button>
            <button className="btn primary" onClick={() => void make()}>Make a new code</button>
          </>}
        >
          <div style={{ fontSize: 13 }}>
            The code written down now stops working, at every counter.
          </div>
        </Modal>
      )}

      {shown && (
        <Modal title="The new recovery code" onClose={() => setShown(null)}>
          <RecoveryCodeShown code={shown} doneLabel="Done" onDone={() => setShown(null)} />
        </Modal>
      )}
    </>
  )
}

/**
 * On every screen, for whoever may reset passwords, while the shop has no code.
 *
 * Shops set up before the code existed have none, and the Staff card alone
 * waits for an owner to open Staff -- which they may first do on the day they
 * have already forgotten. "Later" puts it away until the next sign-in.
 */
export function RecoveryCodeBanner() {
  const { db } = useCore()
  const me = useUser()
  const canWrite = Permissions.can(me.permissions, 'user', 'write')
  const [missing, setMissing] = useState(false)
  const [later, setLater] = useState(false)
  const [shown, setShown] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setMissing((await recoveryCodeState(db)).madeAt === null)
  }, [db])
  useEffect(() => { void refresh() }, [refresh])
  // A code made at another till answers this one too.
  useShopChanged(refresh)

  async function make() {
    setShown(await makeRecoveryCode(db, { actorId: me.id }))
    await refresh()
  }

  if (!canWrite) return null

  return (
    <>
      {missing && !later && !shown && (
        <div style={{ padding: '12px 18px 0', flexShrink: 0 }}>
          <Alert kind="warn">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <strong>This shop has no recovery code.</strong>
                <div>If the administrator password is forgotten, there is no way back in. It takes a minute.</div>
              </div>
              <button className="btn sm" type="button" onClick={() => void make()}>Make a code</button>
              <button className="btn ghost sm" type="button" onClick={() => setLater(true)}>Later</button>
            </div>
          </Alert>
        </div>
      )}

      {shown && (
        <Modal title="The shop's recovery code" onClose={() => setShown(null)}>
          <RecoveryCodeShown code={shown} doneLabel="Done" onDone={() => setShown(null)} />
        </Modal>
      )}
    </>
  )
}
