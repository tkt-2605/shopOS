import { useEffect, useState } from 'react'
import { onJoinRequest, pendingJoin, allowJoin, refuseJoin, type JoinRequest } from '@shopos/core'

/**
 * Somebody at the door, asked about wherever the shopkeeper happens to be.
 *
 * In the shell rather than on the Settings screen, and that is the whole point
 * of it. The person adding a till is standing at the *other* machine; the one
 * who has to say yes is at this one, looking at the billing screen. A prompt
 * that only exists behind Settings is a prompt nobody ever sees, and the press
 * is the entire security of this — see `PendingJoin` in `syncServer.ts`.
 *
 * It can only appear at all while this till is expecting somebody, so it is
 * never a surprise: a shop that has not pressed "Add a till" does not accept
 * the request that would raise it.
 */
export function JoinRequestPrompt() {
  const [asking, setAsking] = useState<JoinRequest | null>(() => pendingJoin())

  useEffect(() => {
    onJoinRequest(setAsking)
    return () => onJoinRequest(null)
  }, [])

  if (asking === null) return null

  return (
    <div className="join-ask">
      <div>
        <div style={{ fontWeight: 600 }}>A till wants to join this shop</div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
          {asking.label ?? `Machine ${asking.deviceId.slice(0, 8)}`}
          {' '}— it should be showing these two digits.
        </div>
      </div>
      <div style={{ fontSize: 30, letterSpacing: 6, fontWeight: 600 }}>{asking.digits}</div>
      <span style={{ flex: 1 }} />
      <button className="btn ghost sm" onClick={() => refuseJoin(asking.requestId)}>No</button>
      <button className="btn primary sm" onClick={() => allowJoin(asking.requestId)}>
        Let it in
      </button>
    </div>
  )
}
