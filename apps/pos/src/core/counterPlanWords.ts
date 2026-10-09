import type { LicenceState, Role } from '@shopos/core'

/**
 * What an extra till says about the plan for several counters, or null when
 * there is nothing to say.
 *
 * The rule (`licensing-and-accounts.md`, *When paid time ends*): a warning on
 * every till in the week before the paid-through date and through grace, and
 * once it has ended, a view-only till that says where to bill instead. Only on
 * a till that syncs through a main -- the main always bills, and so does a
 * till on its own.
 *
 * A pure function of the facts, so the sentences can be got right in a test
 * without a licence, a clock or a second machine.
 */
export interface CounterPlanFacts {
  role: Role
  mayTakeMoney: boolean
  state: LicenceState
  paidThrough: string | null
  graceUntil: string | null
  /** Business date, `YYYY-MM-DD`. */
  today: string
  mainName: string
}

/** How far ahead of the paid-through date the warning starts. */
export const WARN_DAYS = 7

export function counterPlanNotice(f: CounterPlanFacts): string | null {
  if (f.role !== 'till') return null

  if (!f.mayTakeMoney) {
    return `This till is view-only: the plan for several counters has ended. Take bills at `
      + `the main till, ${f.mainName}. Everything here can still be looked up and printed, and `
      + `renewing the plan on any till lets this one bill again.`
  }

  if (f.state === 'grace' && f.graceUntil !== null) {
    return `The plan for several counters ran out on ${f.paidThrough ?? 'its date'}. This till can `
      + `go on billing until ${f.graceUntil}; after that only the main till, ${f.mainName}, takes bills.`
  }

  if (f.state === 'active' && f.paidThrough !== null && daysUntil(f.today, f.paidThrough) <= WARN_DAYS) {
    return `The plan for several counters is paid up to ${f.paidThrough}. Renew it to keep this till `
      + `billing; otherwise, after the grace period, only the main till, ${f.mainName}, takes bills.`
  }

  return null
}

function daysUntil(today: string, day: string): number {
  const at = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)))
  return Math.round((at(day) - at(today)) / 86_400_000)
}
