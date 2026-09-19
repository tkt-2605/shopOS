import { useCallback, useEffect, useState } from 'react'
import { ghostClaims, clearGhostClaims } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { Alert } from './components'

/**
 * A counter claimed by a till that does not exist.
 *
 * What a restore leaves behind. `registers.claimed_by` is a row, so a backup
 * carries it; `device.json` is deliberately not in the backup, because an
 * identity a restore can duplicate is not an identity. So the machine comes up
 * as a new till looking at a shop whose counters all belong to one that is
 * gone — and it cannot bill, because `resolveDeviceRegister` returns null the
 * moment any peer row exists, and it could not take a counter back either,
 * because every screen refuses a claimed one.
 *
 * That leaves a shopkeeper with their own data on a working machine and no way
 * to ring up a sale, and nothing on any screen saying why.
 *
 * Offered on Settings, beside the restore notice, because that is the minute
 * they are already answering questions about the restore rather than a Saturday
 * three weeks later. Its own component rather than another hundred lines in
 * `Settings.tsx`: this has one job, and a thing with one job can be rendered on
 * its own and tested.
 */
export function FreeGhostClaims() {
  const { db, reloadRegister } = useCore()
  const [held, setHeld] = useState(0)
  const [freed, setFreed] = useState(false)

  const look = useCallback(async () => {
    setHeld((await ghostClaims(db)).length)
  }, [db])

  useEffect(() => { void look() }, [look])

  async function release() {
    await clearGhostClaims(db)
    setFreed(true)
    await look()
    // So the machine can pick a counter without being restarted first.
    await reloadRegister()
  }

  if (freed && held === 0) {
    return (
      <div style={{ marginBottom: 11 }}>
        <Alert kind="ok">
          Those counters are free. Open Counters and press “Use here” on the one
          this machine sits at.
        </Alert>
      </div>
    )
  }

  if (held === 0) return null

  return (
    <div style={{ marginBottom: 11 }}>
      <Alert>
        {held === 1
          ? 'One counter in this shop is claimed by a till that no longer exists. '
          : `${held} counters in this shop are claimed by tills that no longer exist. `}
        That happens after a restore: the claim came with the data, the machine did not.
        {' '}
        <button className="link-btn" onClick={() => void release()}>Free them</button>
      </Alert>
    </div>
  )
}
