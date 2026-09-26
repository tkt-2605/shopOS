import { useEffect, useState } from 'react'
import { Money, Loyalty, setSetting, loadLoyaltyProgram } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Card, Field, Alert } from '../../ui/components'
import { Intro } from './parts'

/**
 * Points a customer earns per bill and spends soonest-to-expire first.
 *
 * Checked before it is saved: a program with a point worth nothing, or a box
 * that was not a number, used to go into the setting as it stood and break
 * earning on every bill after.
 */
export function LoyaltySection() {
  const { db } = useCore()
  const [program, setProgram] = useState<Loyalty.LoyaltyProgram | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => { void loadLoyaltyProgram(db).then(setProgram) }, [db])

  function patch(next: Partial<Loyalty.LoyaltyProgram>) {
    setProgram((p) => (p ? { ...p, ...next } : p))
    setSaved(false)
  }

  async function save() {
    if (!program) return
    const problem = Loyalty.programProblem(program)
    if (problem) { setError(problem); return }
    setError(null)
    try {
      await setSetting(db, 'loyalty_program', JSON.stringify(program))
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setError(`The program could not be saved: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!program) return null

  /** A box that was not a number keeps NaN, so the check above can name it. */
  const numberOr = (typed: string) => (typed.trim() === '' ? NaN : Number(typed))

  return (
    <>
      <Intro>
        Points are earned per bill and spent soonest-to-expire first. A change
        applies to bills from now on; points already earned keep their value and
        their expiry.
      </Intro>

      <Card
        title="Loyalty program"
        actions={<button className="btn primary sm" onClick={() => void save()}>Save</button>}
      >
        {error && <div style={{ marginBottom: 11 }}><Alert>{error}</Alert></div>}
        {saved && <div style={{ marginBottom: 11 }}><Alert kind="ok">Saved.</Alert></div>}

        <label className="settings-switch" htmlFor="loyalty-enabled" style={{ borderTop: 0, paddingTop: 0 }}>
          <input type="checkbox" id="loyalty-enabled" checked={program.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })} />
          <span className="settings-option-title">Run a loyalty program</span>
        </label>

        <div className="settings-grid">
          <Field label="One point is worth">
            <input className="input num" id="point-value" defaultValue={Money.format(program.pointValue)}
              onBlur={(e) => patch({ pointValue: Money.parseMoney(e.target.value) ?? (NaN as Money.Money) })} />
          </Field>
          <Field label="Points expire after" hint="Days. Leave blank for never.">
            <input className="input num" id="expiry-days" defaultValue={program.expiryDays ?? ''}
              onBlur={(e) => patch({ expiryDays: e.target.value.trim() === '' ? null : numberOr(e.target.value) })} />
          </Field>
          <Field label="Minimum bill to earn">
            <input className="input num" id="min-bill" defaultValue={Money.format(program.minBillForEarn)}
              onBlur={(e) => patch({ minBillForEarn: Money.parseMoney(e.target.value) ?? (NaN as Money.Money) })} />
          </Field>
          <Field label="Points may pay at most" hint="Per cent of the bill.">
            <input className="input num" id="max-redeem" defaultValue={program.maxRedeemFractionBp / 100}
              onBlur={(e) => patch({ maxRedeemFractionBp: Math.round(numberOr(e.target.value) * 100) })} />
          </Field>
        </div>

        <label className="settings-switch" htmlFor="earn-on-credit">
          <input type="checkbox" id="earn-on-credit" checked={program.earnOnCreditPortion}
            onChange={(e) => patch({ earnOnCreditPortion: e.target.checked })} />
          <span>
            <span className="settings-option-title">Earn points on the credit portion of a bill</span>
            <span className="settings-option-note">
              Off means a customer buying on khata earns only on what they actually paid today.
            </span>
          </span>
        </label>
      </Card>

      <Card
        title="Earning tiers"
        actions={
          <button className="btn sm" onClick={() => patch({ tiers: [...program.tiers, { minSpend: 0 as never, pointsPerHundred: 1 }] })}>
            Add tier
          </button>
        }
      >
        <div className="settings-group-why" style={{ marginTop: 0 }}>The highest tier the bill reaches applies.</div>
        <table>
          <thead>
            <tr><th>Bill is at least</th><th>Points per ₹100</th><th style={{ width: 60 }} /></tr>
          </thead>
          <tbody>
            {program.tiers.map((tier, i) => (
              /* Keyed on what the row holds, not where it sits: the boxes are
                 uncontrolled, and keyed by position, removing the first tier left
                 its figures showing in the row that took its place. */
              <tr key={`${i}:${tier.minSpend}:${tier.pointsPerHundred}:${program.tiers.length}`}>
                <td>
                  <input
                    className="qty-input num" style={{ width: 110, textAlign: 'left' }}
                    aria-label={`Tier ${i + 1}: bill is at least`}
                    defaultValue={Money.format(tier.minSpend)}
                    onBlur={(e) => {
                      const tiers = [...program.tiers]
                      tiers[i] = { ...tier, minSpend: Money.parseMoney(e.target.value) ?? (NaN as Money.Money) }
                      patch({ tiers })
                    }}
                  />
                </td>
                <td>
                  <input
                    className="qty-input num" style={{ width: 70, textAlign: 'left' }}
                    aria-label={`Tier ${i + 1}: points per ₹100`}
                    defaultValue={tier.pointsPerHundred}
                    onBlur={(e) => {
                      const tiers = [...program.tiers]
                      tiers[i] = { ...tier, pointsPerHundred: numberOr(e.target.value) }
                      patch({ tiers })
                    }}
                  />
                </td>
                <td className="r">
                  <button className="btn ghost sm" aria-label={`Remove tier ${i + 1}`}
                    onClick={() => patch({ tiers: program.tiers.filter((_, n) => n !== i) })}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {program.tiers.length === 0 && (
              <tr><td colSpan={3} style={{ color: 'var(--ink-3)' }}>No tiers — nothing is earned.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  )
}
