import { useState } from 'react'
import { Permissions } from '@shopos/core'
import { useUser } from '../core/CoreProvider'
import { Alert } from '../ui/components'
import { CustomerRates } from './pricing/CustomerRates'
import { ItemPrices } from './pricing/ItemPrices'
import { PriceLists } from './pricing/PriceLists'

/**
 * Where prices are set.
 *
 * The engine that reads these has existed since v1 — a four-step chain from a
 * customer's own rate, through their price list, through the shop's list, down
 * to the item's base rate, with quantity tiers and validity dates at each step.
 * Until now nothing could write to it but the demo seed, which meant a shop
 * could be told it had tiered pricing and never find it.
 *
 * Laid out item-first, because that is the question a shopkeeper actually has:
 * not "what is on the wholesale list" but "what does this pen cost, and to
 * whom".
 */

type Tab = 'items' | 'lists' | 'customers'

const TABS: { id: Tab; label: string; what: string }[] = [
  {
    id: 'items',
    label: 'Rates per item',
    what: 'Pick an item and say what it costs on each list, and at what quantity. '
      + 'This is where “₹9 each, ₹8 from a dozen” is set.',
  },
  {
    id: 'lists',
    label: 'Price lists',
    what: 'The named groups of rates — Retail, Wholesale, School. A list on its own '
      + 'does nothing until items are given rates on it and a customer is put on it.',
  },
  {
    id: 'customers',
    label: 'Rates per customer',
    what: 'Put a customer on a list, or give one customer a rate nobody else gets.',
  },
]

export default function Pricing() {
  const user = useUser()
  const [tab, setTab] = useState<Tab>('items')
  const canWrite = Permissions.can(user.permissions, 'price_list', 'write')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1000 }}>
      {/* A screen whose name is a noun and whose job is not obvious from it.
          The first sentence is the one that matters: it says what this page is
          NOT, because the ordinary price of an item lives on Inventory and
          that is where a shopkeeper looking for "prices" has already been. */}
      <div
        style={{
          border: '1px solid var(--rule-strong)', background: 'var(--surface)',
          padding: '13px 15px', fontSize: 13, lineHeight: 1.55,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          This is not where an item’s normal price is set.
        </div>
        <p style={{ margin: '0 0 9px' }}>
          That one lives on the item itself, under <strong>Inventory</strong>. This page is for
          selling the same thing at a <em>different</em> price to somebody — a cheaper rate by
          the dozen, a wholesale list for the trade, a rate you agreed with one school.
          Set nothing here and every sale is at the normal price. Nothing is broken by leaving
          it empty.
        </p>
        <p style={{ margin: '0 0 9px' }}>
          <strong>For example.</strong> A pen is ₹10 in Inventory. Here you make a list called
          Wholesale where that pen is ₹8, and put Sri Vidya School on it. From then on the pen
          rings up at ₹8 for the school and ₹10 for everybody else, with nobody at the counter
          having to remember it.
        </p>
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
          For every line it bills, the counter takes the first of these that has an answer:
          {' '}<strong>this customer’s own rate</strong> → <strong>their price list</strong>
          {' '}→ <strong>the shop’s default list</strong> → <strong>the item’s normal price</strong>.
        </div>
      </div>

      <div>
        <div className="segment">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-pressed={t.id === tab} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {/* Three nouns that all sound like the same thing. Each says its own job
            rather than leaving the shop to work out how they differ. */}
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 8, lineHeight: 1.5 }}>
          {TABS.find((t) => t.id === tab)!.what}
        </div>
      </div>

      {!canWrite && <Alert kind="warn">You can see prices here but not change them.</Alert>}

      {tab === 'items' && <ItemPrices canWrite={canWrite} />}
      {tab === 'lists' && <PriceLists canWrite={canWrite} />}
      {tab === 'customers' && <CustomerRates canWrite={canWrite} />}
    </div>
  )
}
