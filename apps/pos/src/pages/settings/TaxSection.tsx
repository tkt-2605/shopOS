import type { TaxScheme } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Card, Alert } from '../../ui/components'
import { Choice, Group, Intro } from './parts'
import { BooksCard } from './BooksCard'

/** For the sentence that says what the till is assuming while nobody has said. */
const SCHEME_LABEL: Record<TaxScheme, string> = {
  regular: 'Registered',
  composition: 'Composition scheme',
  unregistered: 'Not registered',
}

/**
 * The rules every bill is rung up under: whether tax is charged, what happens
 * when the count says there is nothing left, and what becomes of the last few
 * paise. Each takes effect on the next bill, and none rewrites one already made.
 */
export function TaxSection() {
  const {
    stockPolicy, setStockPolicyTo, rounding, setRoundingTo,
    taxScheme, taxSchemeAsked, setTaxSchemeTo,
  } = useCore()

  return (
    <>
      <Intro>
        The rules every bill is rung up under. A change applies from the next bill;
        bills already made keep the rules they were made with.
      </Intro>

      <Card title="GST">
        <Group
          title="What this shop is, for GST"
          why={
            'This decides whether the till adds tax to a bill at all, and what the paper handed to the '
            + 'customer is called. It is the one setting here that can be wrong in a way that costs money: '
            + 'a shop collecting tax it is not registered to collect has to give it back, and a registered '
            + 'shop that stops charging has to find the difference out of its own takings. Item tax rates '
            + 'are kept whichever is chosen, so nothing has to be re-entered if this changes.'
          }
        >
          {!taxSchemeAsked && (
            <div style={{ marginBottom: 9 }}>
              <Alert kind="warn">
                Nobody has answered this yet, so the till is going by whether a GSTIN is set on the
                shop details — it is treating this shop as
                <strong>{` ${SCHEME_LABEL[taxScheme].toLowerCase()}`}</strong>. Choosing below settles it.
              </Alert>
            </div>
          )}
          <Choice
            label="GST scheme"
            value={taxScheme}
            onChange={(next) => void setTaxSchemeTo(next)}
            options={[
              {
                id: 'regular',
                title: 'Registered, and charges GST',
                note: 'The ordinary case. CGST and SGST on a local sale, IGST across a state line, and the bill is headed Tax Invoice.',
              },
              {
                id: 'composition',
                title: 'Composition scheme',
                note: 'A flat percentage paid out of the shop’s own pocket. The law forbids collecting tax from the customer, so the till adds none and the paper is a Bill of Supply carrying the sentence the rules require.',
              },
              {
                id: 'unregistered',
                title: 'Not registered for GST',
                note: 'No GSTIN, no tax on the bill, and the paper is an Invoice rather than a tax invoice. Right for a shop under the turnover threshold, and for one that has applied and is waiting.',
              },
            ]}
          />
        </Group>
      </Card>

      <BooksCard />

      <Card title="At the counter">
        <Group
          title="When the count says there is nothing left"
          why={
            'The customer is at the counter holding the item and the records say it does not exist. '
            + 'Counts are wrong in every shop that has just started, so this decides whether that is the '
            + 'cashier’s problem or the owner’s. Whatever is chosen, the item turns up on “Counts that need '
            + 'fixing” on the stock count screen, and the goods still leave at a cost so the margin stays right.'
          }
        >
          <Choice
            label="Selling below the count"
            value={stockPolicy}
            onChange={(next) => void setStockPolicyTo(next)}
            options={[
              {
                id: 'block',
                title: 'Refuse the sale',
                note: 'Nothing can be sold that the records do not show. Right where the count is the point — a pharmacy, or anything licensed.',
              },
              {
                id: 'warn',
                title: 'Warn, and let it through',
                note: 'The cashier is told what is short and can go ahead. The queue moves and the owner gets a list to fix.',
              },
              {
                id: 'allow',
                title: 'Say nothing',
                note: 'Fastest at the counter. A count that is genuinely wrong is never noticed at the till.',
              },
            ]}
          />
        </Group>

        <Group
          title="The last few paise"
          why={
            'GST on a round rate almost never lands on a whole rupee, so a bill of ₹99.60 is the ordinary '
            + 'case. The difference prints on the bill as its own “Round off” line and is totalled on the '
            + 'day’s report, so nothing is quietly kept or quietly given away. The taxable value and the tax '
            + 'do not move: only the total does.'
          }
        >
          <Choice
            label="Rounding"
            value={rounding}
            onChange={(next) => void setRoundingTo(next)}
            options={[
              {
                id: 'none',
                title: 'Charge what it comes to',
                note: '₹99.60 is ₹99.60. Right for a shop taking card or UPI, where the paise can actually be collected.',
              },
              {
                id: 'nearest',
                title: 'Nearest rupee',
                note: '₹99.60 becomes ₹100 and ₹99.40 becomes ₹99. Over a day it comes out roughly even. What most counters do.',
              },
              {
                id: 'up',
                title: 'Always up',
                note: '₹99.10 becomes ₹100. The shop never loses a paisa and the customer always pays the difference.',
              },
              {
                id: 'down',
                title: 'Always down',
                note: '₹99.90 becomes ₹99. The customer never pays more than the bill; the shop absorbs it.',
              },
            ]}
          />
        </Group>
      </Card>
    </>
  )
}
