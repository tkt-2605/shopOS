import { describe, it, expect } from 'vitest'
import { advice } from '../src/core/startupAdvice'
import type { FailureKind } from '../src/core/CoreProvider'

/**
 * What a till that will not open tells the person standing in front of it.
 *
 * These are tests about a button, which sounds small, and they are here because
 * pressing it at the wrong moment destroys a day's trade. "Restore a backup"
 * replaces the current database with an older copy. That is the right answer to
 * a damaged file and the wrong answer to every other reason on this screen — and
 * the screen used to offer it as the first and most prominent action to all of
 * them.
 */

const ALL: FailureKind[] = [
  'corrupt', 'locked', 'io', 'restore_incomplete', 'invalid_shop', 'schema_too_new', 'schema_unversioned', 'other',
]

describe('a till that will not open', () => {
  it('always shows a way out, whatever went wrong', () => {
    /* A screen that hides the fix is worse than one that ranks it. Somebody is
       standing at a counter with customers waiting and no way to ring anybody
       who knows more than the screen does. */
    for (const kind of ALL) {
      expect(advice(kind).title.length, kind).toBeGreaterThan(0)
      expect(['first', 'offered', 'last']).toContain(advice(kind).restore)
    }
  })

  it('pushes Restore hardest for the one reason restoring actually fixes', () => {
    expect(advice('corrupt').restore).toBe('first')
    expect(advice('corrupt').says).toMatch(/backup/i)
  })

  it('will not put Restore first in front of a till that is merely behind', () => {
    /* The database was written by a newer ShopOS. Restoring here replaces what
       that newer version wrote — a day's billing gone, while following the
       instructions on the screen. */
    expect(advice('schema_too_new').restore).toBe('last')
    expect(advice('schema_too_new').says).toMatch(/do not restore/i)
    expect(advice('schema_too_new').title).not.toMatch(/damaged/i)
  })

  it('will not put Restore first in front of a file that is only held open', () => {
    /* Nothing is damaged. Somebody double-clicked twice, or an antivirus
       scanner has the file for a moment. Restoring throws away everything
       billed since the backup to solve a problem that ends by itself. */
    expect(advice('locked').restore).toBe('last')
    expect(advice('locked').says).toMatch(/do not restore/i)
    expect(advice('locked').says).toMatch(/second copy of ShopOS/i)
  })

  it('never tells a shop with a damaged file to go and update the till', () => {
    // Updating does nothing at all for a JPEG somebody renamed to shop.db.
    expect(advice('corrupt').says).not.toMatch(/update this till/i)
    expect(advice('corrupt').title).not.toMatch(/updating/i)
  })

  it('never tells a shop that is behind that its data is damaged', () => {
    const said = advice('schema_too_new')
    expect(said.says).toMatch(/nothing is wrong with the database/i)
    expect(said.says).not.toMatch(/damaged|corrupt/i)
  })

  it('checks the drive before the backup, when the file could not be reached', () => {
    /* A till whose data lives on a USB disk that fell out. Restoring onto a
       disk that is not there is not going to go well either. */
    expect(advice('io').says).toMatch(/plugged in|switched on/i)
  })

  it('invents no advice for a cause nobody has identified', () => {
    /* The error itself is on the screen above this. Guessing a cause is how a
       shop gets told to restore a backup it did not need. */
    expect(advice('other').says).toBeNull()
    expect(advice('schema_unversioned').says).toBeNull()
  })

  it('gives every reason its own title, so two are never confused', () => {
    const titles = ALL.map((k) => advice(k).title)
    const distinct = new Set(titles)

    /* `schema_unversioned` and `other` deliberately share one, having nothing
       specific to say; every other reason is its own sentence. */
    expect(distinct.size).toBe(ALL.length - 1)
  })
})

describe('the two ways of not starting that open nothing at all', () => {
  it('says a restore that did not finish lost nothing, and how to go back', () => {
    const said = advice('restore_incomplete')
    expect(said.restore).toBe('offered')
    expect(said.says).toMatch(/Nothing has been lost/)
    expect(said.says).toMatch(/Cancel a pending restore/)
  })

  it('points at the shortcut, not at a backup, for a shop name that cannot exist', () => {
    const said = advice('invalid_shop')
    expect(said.restore).toBe('last')
    expect(said.says).toMatch(/shortcut/)
    expect(said.says).toMatch(/Do not restore a backup/)
  })
})
