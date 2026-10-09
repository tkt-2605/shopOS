import { useCallback, useEffect, useState } from 'react'
import {
  businessDate, entitlement, listPeers, mainTill, mayTakeMoney, tillRole,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { onSyncRound } from '../core/syncLoop'
import { counterPlanNotice } from '../core/counterPlanWords'
import { Alert } from './components'

/**
 * The plan for several counters, from an extra till's side.
 *
 * On every screen, because a till that has gone view-only refuses the next
 * bill, and the reason -- and where to bill instead -- has to be in front of
 * whoever finds the counter refusing. Asked again after each sync round,
 * which is how a renewal pasted on another till arrives here. The sentences
 * are `counterPlanNotice`'s.
 */
export function CounterPlanBanner() {
  const { db } = useCore()
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const role = await tillRole(db)
    if (role !== 'till') { setNotice(null); return }
    const [held, main, peers, ok] = await Promise.all([
      entitlement(db), mainTill(db), listPeers(db), mayTakeMoney(db),
    ])
    const named = peers.find((p) => p.deviceId === main.device)
    setNotice(counterPlanNotice({
      role,
      mayTakeMoney: ok,
      state: held.state,
      paidThrough: held.paidThrough,
      graceUntil: held.graceUntil,
      today: businessDate(),
      mainName: named?.label ?? 'the main till',
    }))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => onSyncRound(() => { void refresh() }), [refresh])

  if (notice === null) return null
  return (
    <div style={{ padding: '12px 18px 0', flexShrink: 0 }}>
      <Alert kind="warn">{notice}</Alert>
    </div>
  )
}
