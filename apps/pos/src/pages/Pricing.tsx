import { useState } from 'react'
import { Permissions } from '@shopos/core'
import { useUser } from '../core/CoreProvider'
import { Alert } from '../ui/components'
import { DoublePrices } from '../ui/DoublePrices'
import { CustomerRates } from './pricing/CustomerRates'
import { ListPrices } from './pricing/ListPrices'
import { LadderFile } from './pricing/LadderFile'

/**
 * Special prices: what differs from an item's normal price, and for whom.
 *
 * An item's normal price is its selling rate, set on the item with its own
 * quantity breaks (Inventory). This page is only for somebody paying
 * something else, and it starts from who that is: a group of customers on a
 * price list, or one customer. It used to start from the item, across three
 * tabs and a long explanation, and the shop's own list sat beside the others
 * as one more place to type an item's normal price (24 October).
 */

type Tab = 'lists' | 'customers'

const TABS: { id: Tab; label: string; what: string }[] = [
  {
    id: 'lists',
    label: 'Price lists',
    what: 'A price list is a set of prices for a group of customers: Wholesale, School, Staff. '
      + 'Put customers on it, and give it prices for the items that differ.',
  },
  {
    id: 'customers',
    label: 'One customer',
    what: 'Which list a customer buys on, and prices only they get.',
  },
]

export default function Pricing() {
  const user = useUser()
  const [tab, setTab] = useState<Tab>('lists')
  /* Raised after an import, so the open tab reads again what the file changed. */
  const [version, setVersion] = useState(0)
  const canWrite = Permissions.can(user.permissions, 'price_list', 'write')
  const reload = () => setVersion((v) => v + 1)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1000 }}>
      <div style={{ border: '1px solid var(--rule-strong)', background: 'var(--surface)', padding: '12px 15px', fontSize: 13, lineHeight: 1.55 }}>
        <strong>Prices that differ from an item’s normal price.</strong>{' '}
        An item’s normal price, and its cheaper-by-the-quantity breaks, are set on the item in Inventory.
        Here you give a group of customers their own prices, or one customer theirs. Set nothing here and
        everybody pays normal prices.
      </div>

      {canWrite && <DoublePrices onDone={reload} />}

      <div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="segment">
            {TABS.map((t) => (
              <button key={t.id} type="button" aria-pressed={t.id === tab} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <LadderFile canWrite={canWrite} onDone={reload} />
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 8, lineHeight: 1.5 }}>
          {TABS.find((t) => t.id === tab)!.what}{' '}
          At the counter a customer pays the first of: <strong>their own price</strong> → <strong>their price list</strong>
          {' '}→ <strong>the item’s normal price</strong>.
        </div>
      </div>

      {!canWrite && <Alert kind="warn">You can see prices here but not change them.</Alert>}

      {tab === 'lists' && <ListPrices key={version} canWrite={canWrite} />}
      {tab === 'customers' && <CustomerRates key={version} canWrite={canWrite} />}
    </div>
  )
}
