import { describe, it, expect, afterEach } from 'vitest'
import { CLOCK_TOLERANCE_MS } from '@shopos/core'
import { host, joiner, stopAll } from './bench.js'

/**
 * Two tills that do not agree what time it is.
 *
 * Nobody sets a shop PC's clock. One is a minute fast, one has been off for a
 * fortnight and came back with a stale RTC, one had its time zone changed by
 * whoever was trying to fix the printer. So every decision made by comparing
 * one machine's `now` against another's is being made on numbers that disagree,
 * and two such decisions exist: which edit wins a merge, and whether a signed
 * request is fresh enough to accept.
 *
 * The clocks here are **injected, not faked**. `vi.useFakeTimers()` moves the
 * whole process, so both tills would move together and stay in agreement —
 * which is precisely the arrangement that hid this class of bug for 1047 tests.
 * Each till is given its own function, five minutes apart, and neither can see
 * the other's.
 */

afterEach(stopAll)

/** A clock that runs at real speed, offset from this machine's. */
function skewedBy(ms: number): () => number {
  return () => Date.now() + ms
}

describe('the signing window', () => {
  it('accepts a request from a till 4:59 out', async () => {
    const front = await host()
    const back = await joiner({ clock: skewedBy(CLOCK_TOLERANCE_MS - 1_000) })

    await back.pairWith(front)
    const round = await back.sync(front)

    expect(round.ok).toBe(true)
  })

  it('refuses a request from a till 5:01 out', async () => {
    const front = await host()
    const back = await joiner({ clock: skewedBy(CLOCK_TOLERANCE_MS + 1_000) })

    await back.pairWith(front)
    const round = await back.sync(front)

    /* `STALE`, and it must not be silent. A shop whose second till will not
       sync because its clock is wrong has a fixable problem, and the only way
       anybody finds out is that the refusal says so. */
    expect(round.ok).toBe(false)
  })

  it('refuses in the other direction too, by the same margin', async () => {
    // Symmetry asserted rather than assumed: the window is |now - theirs|, and
    // a one-sided check would pass every test written from one end.
    const front = await host()
    const back = await joiner({ clock: skewedBy(-(CLOCK_TOLERANCE_MS + 1_000)) })

    await back.pairWith(front)
    expect((await back.sync(front)).ok).toBe(false)
  })

  it('still pairs when the clocks are far apart', async () => {
    /* Pairing is the one unsigned request, so it is not subject to the window —
       and it must not be, or a shop with a wrong clock could never pair the
       till that would have let them notice. */
    const front = await host()
    const back = await joiner({ clock: skewedBy(60 * 60 * 1000) })

    await expect(back.pairWith(front)).resolves.toBeUndefined()
  })
})

describe('a row edited on both tills', () => {
  it('resolves to one winner and records the loser', async () => {
    const front = await host()
    const back = await joiner({ clock: skewedBy(5 * 60 * 1000) })

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    const id = await front.as(async () => {
      const row = await front.db.get<{ id: string }>(`SELECT id FROM registers LIMIT 1`)
      return row!.id
    })

    // The same row, changed on both sides since they last agreed.
    await front.as(() => front.db.execute(
      `UPDATE registers SET name = ?, rev = rev + 1 WHERE id = ?`, ['Front, renamed', id]))
    await back.as(() => back.db.execute(
      `UPDATE registers SET name = ?, rev = rev + 1 WHERE id = ?`, ['Back, renamed', id]))

    const round = await back.sync(front)
    expect(round.ok).toBe(true)

    // One answer, the same on both tills. Which one wins is the merge rule's
    // business; that the two tills agree afterwards is this file's.
    const onFront = await front.db.get<{ name: string }>(
      `SELECT name FROM registers WHERE id = ?`, [id])
    await front.sync(back)
    const onBack = await back.db.get<{ name: string }>(
      `SELECT name FROM registers WHERE id = ?`, [id])

    expect(onBack?.name).toBe(onFront?.name)
  })
})
