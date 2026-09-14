import { DocumentDesk, type DeskConfig } from '../ui/DocumentDesk'

/**
 * What the shop has ordered from a supplier.
 *
 * Under Stock rather than under Sell, because it is a buying job: the person
 * who notices the shelf is empty is the person who raises it.
 *
 * It commits no money — there is no payable until an invoice arrives — and it
 * moves no stock until the goods do. "Receive into stock" is the moment both
 * become true, and it posts the goods in at the cost that was ordered rather
 * than at whatever the catalogue says today.
 */

const CONFIG: DeskConfig = {
  kinds: ['purchase_order'],
  party: 'supplier',
  labels: {
    purchase_order: {
      name: 'Purchase order',
      plural: 'Purchase orders',
      note: 'What has been ordered from a supplier and not yet arrived. Nothing is owed and nothing is '
        + 'on the shelf until you receive it, which posts the goods in at the cost you ordered them at.',
    },
  },
}

export default function PurchaseOrders() {
  return <DocumentDesk config={CONFIG} />
}
