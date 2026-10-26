import { useState } from 'react'
import { DocumentDesk, type DeskConfig } from '../ui/DocumentDesk'
import { OnlineOrders } from '../ui/OnlineOrders'
import { useSellsOnline } from './settings/OnlineSection'

/**
 * What the shop has promised a customer, before any money changes hands.
 *
 * A quotation is a price held open for a while; a sales order is a promise to
 * deliver. Both sit on the same screen because a shop moves between them in one
 * breath — the school accepts the quote, and the quote becomes the order.
 *
 * Neither moves stock. A sales order for fifty reams does not take fifty reams
 * off the shelf, because nothing has left the shop; what it does is record that
 * fifty are owed, so the remainder is a fact when half of them go out.
 */

const CONFIG: DeskConfig = {
  kinds: ['quotation', 'sales_order'],
  party: 'customer',
  labels: {
    quotation: {
      name: 'Quotation',
      plural: 'Quotations',
      note: 'A price held open for a customer. Nothing is owed and nothing moves until they accept it — '
        + 'and when they do, the order carries the rate that was quoted, not today’s.',
    },
    sales_order: {
      name: 'Sales order',
      plural: 'Sales orders',
      note: 'What a customer has ordered and the shop has agreed to deliver. Stock is not set aside: '
        + 'what this records is how much is owed, so half a delivery leaves the right half outstanding.',
    },
  },
}

export default function Orders() {
  /* Orders from the storefront sit beside these, for a shop that sells online:
     accepted, they become sales orders like the ones on the other tab. */
  const sellsOnline = useSellsOnline()
  const [online, setOnline] = useState(false)
  if (!sellsOnline) return <DocumentDesk config={CONFIG} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="segment">
        <button type="button" aria-pressed={!online} onClick={() => setOnline(false)}>Quotations & orders</button>
        <button type="button" aria-pressed={online} onClick={() => setOnline(true)}>Online</button>
      </div>
      {online ? <OnlineOrders /> : <DocumentDesk config={CONFIG} />}
    </div>
  )
}
