import { useEffect, useState } from 'react'
import {
  billAnywayAfterRestore, onRestoreHold, restoreHold, restoreHoldMessage, type RestoreHold,
} from '../core/restoreHold'
import { Alert } from './components'

/**
 * A till restored from a backup that has not caught up with the shop yet.
 *
 * On every screen, because billing is held on this till until it does, and
 * the reason has to be in front of whoever finds the counter refusing.
 */
export function RestoreHoldBanner() {
  const [hold, setHold] = useState<RestoreHold | null>(restoreHold)

  useEffect(() => onRestoreHold(setHold), [])

  if (hold === null) return null

  return (
    <div style={{ padding: '12px 18px 0', flexShrink: 0 }}>
      <Alert>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <strong>Billing is held on this till until it catches up.</strong>
          <div>{restoreHoldMessage(hold)}</div>
          <div>
            <button className="link-btn" onClick={() => void billAnywayAfterRestore()}>
              Bill anyway
            </button>
          </div>
        </div>
      </Alert>
    </div>
  )
}
