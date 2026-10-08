/**
 * The amounts a customer is likely to hand over for a bill, for one tap each:
 * the next round fifty, hundred and five hundred above it, and the next note
 * of two thousand -- the notes an Indian counter actually sees. In paise,
 * strictly above the bill, no repeats, at most four.
 */
export function cashNotes(due: number): number[] {
  const out: number[] = []
  for (const step of [5_000, 10_000, 50_000, 200_000]) {
    const next = (Math.floor(due / step) + 1) * step
    if (next > due && !out.includes(next)) out.push(next)
  }
  return out.sort((a, b) => a - b).slice(0, 4)
}
