/**
 * A posting date is the shop's calendar date, not UTC's.
 *
 * `toISOString().slice(0, 10)` looks like the obvious way to get one and is wrong
 * everywhere east or west of Greenwich: in IST a bill rung at 00:30 is 19:00 the
 * previous day in UTC, so it would be filed against yesterday — and yesterday's
 * drawer, which has already been counted and closed.
 */
export function businessDate(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}

/** The date `days` after (or before, if negative) the given day, in local terms. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return businessDate(d)
}
