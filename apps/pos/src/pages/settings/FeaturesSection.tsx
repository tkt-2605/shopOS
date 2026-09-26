import { useCore } from '../../core/CoreProvider'
import { Card } from '../../ui/components'
import { Intro, Switch } from './parts'

/**
 * The parts of the product a shop can do without.
 *
 * Switching one off takes it off the screens that ask for it. Nothing already
 * saved is deleted, and turning it back on finds it where it was.
 */
export function FeaturesSection() {
  const { features, setFeatureFlag } = useCore()

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
