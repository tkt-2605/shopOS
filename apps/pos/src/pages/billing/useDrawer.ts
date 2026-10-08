import { useEffect, useState } from 'react'
import { Money, Permissions, openSessionFor, getOrOpenSession, type SqlDriver } from '@shopos/core'

/**
 * This counter's cash drawer, as the payment dialog needs it: whether it is
 * open, asked each time the dialog opens, and the means to open it there and
 * then -- so the first cash bill of the day is not taken into no drawer.
 */
export function useDrawer(
  db: SqlDriver,
  registerId: string,
  user: { id: string; permissions: Permissions.PermissionSet },
  paying: boolean,
): { closed: boolean; canOpen: boolean; open: (openingCash: Money.Money) => Promise<string | null> } {
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (!paying) return
    let live = true
    void openSessionFor(db, registerId).then((id) => { if (live) setClosed(id === null) })
    return () => { live = false }
  }, [paying, db, registerId])

  const open = async (openingCash: Money.Money): Promise<string | null> => {
    try {
      await getOrOpenSession(db, { registerId, userId: user.id, openingCash })
      setClosed(false)
      return null
    } catch (err) {
      return `The counter could not be opened: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  return { closed, canOpen: Permissions.can(user.permissions, 'cash_session', 'create'), open }
}
