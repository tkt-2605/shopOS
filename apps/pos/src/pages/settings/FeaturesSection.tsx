import { useEffect, useState } from 'react'
import { sharedBarcodes, type BarcodeOnSeveral } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Alert, Card } from '../../ui/components'
import { Intro, Switch } from './parts'

/**
 * The parts of the product a shop can do without.
 *
 * Switching one off takes it off the screens that ask for it. Nothing already
 * saved is deleted, and turning it back on finds it where it was.
 */
export function FeaturesSection() {
  const { db, features, setFeatureFlag } = useCore()
  // Codes already on several items: left as they are, and listed so the owner can sort them out.
  const [onSeveral, setOnSeveral] = useState<BarcodeOnSeveral[]>([])
  useEffect(() => {
    if (!features.uniqueBarcode) return
    let live = true
    void sharedBarcodes(db).then((s) => { if (live) setOnSeveral(s) })
    return () => { live = false }
  }, [db, features.uniqueBarcode])

  return (
    <>
      <Intro>
        Not every shop needs everything. Switching one of these off takes it off the
        screens that ask for it — nothing already saved is deleted, and turning it
        back on finds it where it was.
      </Intro>

      <Card title="Items">
        <Switch
          id="feature-multi-barcode"
          on={features.multiBarcode}
          onChange={(on) => void setFeatureFlag('multiBarcode', on)}
          title="Several barcodes for one item"
          note={
            'The manufacturer’s code, your own printed tag, and the one on the old packaging '
            + 'still at the back of the shelf — all finding the same item. Off, the item form '
            + 'asks for one code. Codes already saved go on working at the counter either way: a '
            + 'scan that stopped finding its item would be the worst thing this switch could do.'
          }
        />
        <Switch
          id="feature-unique-barcode"
          on={features.uniqueBarcode}
          onChange={(on) => void setFeatureFlag('uniqueBarcode', on)}
          title="One item per barcode"
          note={
            'On, a barcode another item already has is refused, in the item form and in a '
            + 'catalogue file, and says which item has it. Off, the same code may go on two items '
            + '— one EAN on two pack sizes — and scanning it asks which. Codes already on two '
            + 'items are left as they are, and listed here so you can sort them out.'
          }
        />
        {features.uniqueBarcode && onSeveral.length > 0 && (
          <Alert kind="warn">
            <p>{onSeveral.length === 1 ? 'One code is' : `${onSeveral.length} codes are`} still on more than one item:</p>
            <ul>
              {onSeveral.slice(0, 20).map((s) => (
                <li key={s.barcode}>{s.barcode}: {s.items.map((i) => i.productName).join(', ')}</li>
              ))}
            </ul>
            {onSeveral.length > 20 && <p>and {onSeveral.length - 20} more.</p>}
          </Alert>
        )}
        <Switch
          id="feature-tiered-pricing"
          on={features.tieredPricing}
          onChange={(on) => void setFeatureFlag('tieredPricing', on)}
          title="Cheaper by the quantity"
          note={
            'One is ₹15, ten or more are ₹12, twenty or more are ₹11. Off, an item has '
            + 'one price and the forms ask for one number. Any breaks already written stay in the '
            + 'database, but they stop setting prices while this is off — a price that is still '
            + 'being charged by a rule nobody can see is worse than no rule at all.'
          }
        />
      </Card>

      <Card title="Stock">
        <Switch
          id="feature-batch-expiry"
          on={features.batchExpiry}
          onChange={(on) => void setFeatureFlag('batchExpiry', on)}
          title="Batch numbers and expiry dates"
          note={
            'For medicines, baby food and anything else with a date on the pack. On, Stock in '
            + 'asks for the batch and expiry of each line, the counter shows which batch a sale '
            + 'comes out of — soonest to expire first — and lets the cashier pick another, and '
            + 'Inventory lists what expires in the next three months. Items received without a '
            + 'batch go on selling as before. Off, none of that is asked; batches already recorded '
            + 'keep their balances, and turning it back on finds them right.'
          }
        />
      </Card>

      <Card title="Customers">
        <Switch
          id="feature-unique-phone"
          on={features.uniquePhone}
          onChange={(on) => void setFeatureFlag('uniquePhone', on)}
          title="One customer per phone number"
          note={
            'The number is what a cashier searches on, so the same person entered twice under '
            + 'one number is two khata accounts and two balances. On, a number already in use is '
            + 'refused and the form offers to open whoever has it. Off, the same warning appears '
            + 'and the save goes through — for the household that shares one phone between two '
            + 'accounts on purpose. Nothing already saved is changed either way.'
          }
        />
      </Card>
    </>
  )
}
