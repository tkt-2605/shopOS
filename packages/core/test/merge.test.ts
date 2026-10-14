import { describe, it, expect } from 'vitest'
import { decideRow, decideDeletion, type MergeInput } from '../src/domain/merge.js'

/**
 * The rule that decides which copy of a row survives.
 *
 * Every test here is about one of the two ways a merge rule fails a shop: it
 * drops an edit somebody made and says nothing, or — worse and less obvious —
 * the two tills decide differently and stay disagreeing for ever, each certain
 * it is right, with no further sync able to settle it.
 */

const TILL_A = '0f0a6f6c-1111-4111-8111-111111111111'
const TILL_B = '9f9b7d7d-2222-4222-8222-222222222222'

function ask(over: Partial<MergeInput>) {
  return decideRow({
    mine: {}, theirs: {}, myDevice: TILL_A, theirDevice: TILL_B, ...over,
  })
}

describe('the revision decides', () => {
  it('keeps the copy that has had more changes applied to it', () => {
    const d = ask({ mine: { rev: 7 }, theirs: { rev: 4 } })
    expect(d.winner).toBe('mine')
    expect(d.reason).toBe('higher_rev')
  })

  it('takes the other till when it is the one further ahead', () => {
    expect(ask({ mine: { rev: 2 }, theirs: { rev: 9 } }).winner).toBe('theirs')
  })

  it('does not let a clock overrule a revision', () => {
    /* A till whose clock is an hour slow must not lose an edit it genuinely made
       later in the sequence. This is the whole reason `rev` is consulted first. */
    const d = ask({
      mine: { rev: 5, updatedAt: '2026-01-01T09:00:00.000Z' },
      theirs: { rev: 3, updatedAt: '2026-01-01T23:00:00.000Z' },
    })
    expect(d.winner).toBe('mine')
    expect(d.reason).toBe('higher_rev')
  })
})

describe('when the revisions are level', () => {
  it('falls back to which was changed later', () => {
    const d = ask({
      mine: { rev: 4, updatedAt: '2026-01-01T09:00:00.000Z' },
      theirs: { rev: 4, updatedAt: '2026-01-01T10:00:00.000Z' },
    })
    expect(d.winner).toBe('theirs')
    expect(d.reason).toBe('later_timestamp')
  })

  it('uses the time when neither side carries a revision at all', () => {
    // doc_formats looked like this before migration 022 gave it one.
    const d = ask({
      mine: { updatedAt: '2026-03-02T08:00:00.000Z' },
      theirs: { updatedAt: '2026-03-01T08:00:00.000Z' },
    })
    expect(d.winner).toBe('mine')
    expect(d.reason).toBe('later_timestamp')
  })

  it('prefers a copy that carries a time to one that carries none', () => {
    expect(ask({ mine: {}, theirs: { updatedAt: '2026-03-01T08:00:00.000Z' } }).winner)
      .toBe('theirs')
  })
})

describe('the tiebreak exists so both tills agree', () => {
  /* The failure this prevents is the quiet one: two machines resolving the same
     row differently and each keeping its own answer for ever. */

  it('settles a dead heat rather than leaving it open', () => {
    const same = { rev: 4, updatedAt: '2026-01-01T09:00:00.000Z' }
    const d = ask({ mine: same, theirs: same })
    expect(d.reason).toBe('device_tiebreak')
  })

  it('reaches the same answer from either side of the wire', () => {
    const same = { rev: 4, updatedAt: '2026-01-01T09:00:00.000Z' }

    // The same disagreement, asked on till A and then on till B.
    const onA = decideRow({ mine: same, theirs: same, myDevice: TILL_A, theirDevice: TILL_B })
    const onB = decideRow({ mine: same, theirs: same, myDevice: TILL_B, theirDevice: TILL_A })

    // A says "theirs", B says "mine" — both meaning the row belonging to B.
    expect(onA.winner).toBe('theirs')
    expect(onB.winner).toBe('mine')
  })

  it('settles a dead heat by the rows themselves, whoever is asking and whoever sent it', () => {
    /* Behind a main every row arrives from the main, so "the other device" is
       the main on a counter and the counter on the main -- and settling by
       device id had the two settle the same pair of rows in opposite
       directions. The rows are the one thing every till sees alike. */
    const at = { rev: 2, updatedAt: '2026-01-01T09:00:00.000Z' }
    const low = { ...at, content: '[["base_rate",45000]]' }
    const high = { ...at, content: '[["base_rate",55000]]' }

    const onMain = decideRow({ mine: low, theirs: high, myDevice: TILL_A, theirDevice: TILL_B })
    const onCounter = decideRow({ mine: high, theirs: low, myDevice: TILL_B, theirDevice: TILL_A })
    const elsewhere = decideRow({ mine: high, theirs: low, myDevice: TILL_A, theirDevice: TILL_A })

    expect(onMain).toMatchObject({ winner: 'theirs', reason: 'content_tiebreak' })
    expect(onCounter.winner).toBe('mine')
    expect(elsewhere.winner).toBe('mine')
  })

  it('agrees from either side on a revision too', () => {
    const onA = decideRow({
      mine: { rev: 2 }, theirs: { rev: 8 }, myDevice: TILL_A, theirDevice: TILL_B,
    })
    const onB = decideRow({
      mine: { rev: 8 }, theirs: { rev: 2 }, myDevice: TILL_B, theirDevice: TILL_A,
    })
    expect(onA.winner).toBe('theirs')
    expect(onB.winner).toBe('mine')
  })

  it('changes nothing when the two copies cannot be told apart', () => {
    const same = { rev: 4, updatedAt: '2026-01-01T09:00:00.000Z' }
    const d = decideRow({ mine: same, theirs: same, myDevice: TILL_A, theirDevice: TILL_A })
    expect(d.winner).toBe('mine')
    expect(d.reason).toBe('identical')
    expect(d.contested).toBe(false)
  })
})

describe('saying when somebody lost something', () => {
  it('is quiet when only one side had changed', () => {
    const d = ask({ mine: { rev: 7 }, theirs: { rev: 4 } })
    expect(d.contested).toBe(false)
    expect(d.explain).not.toMatch(/dropped/)
  })

  it('says so when both tills changed it since they last agreed', () => {
    const d = ask({ mine: { rev: 7 }, theirs: { rev: 4 }, bothChangedSinceLastSync: true })
    expect(d.contested).toBe(true)
    expect(d.explain).toMatch(/an edit is being dropped/)
  })

  it('never infers a conflict from the revisions on their own', () => {
    /* A higher revision does not prove the winner had seen the loser's change.
       Guessing here would put a warning on a shop's screen every time one till
       was simply behind, and a warning that cries wolf is one nobody reads. */
    const d = ask({ mine: { rev: 900 }, theirs: { rev: 1 } })
    expect(d.contested).toBe(false)
  })

  it('explains itself in words a shopkeeper could read', () => {
    const d = ask({ mine: { rev: 4 }, theirs: { rev: 9 } })
    expect(d.explain).toBe('The other till wins — revision 9 over 4.')
  })
})

describe('a row deleted on one side', () => {
  it('stays deleted when nothing has touched it since', () => {
    expect(decideDeletion({ deletedRev: 5, survivingRev: 5 }).winner).toBe('delete')
  })

  it('comes back when the other till changed it after the delete', () => {
    // Somebody deliberately brought it back; that is not a disagreement.
    expect(decideDeletion({ deletedRev: 5, survivingRev: 8 }).winner).toBe('keep')
  })

  it('prefers the delete when there is nothing to compare', () => {
    /* Of the two mistakes, a row wrongly kept is deleted again in a second and a
       row wrongly deleted takes whatever was attached to it. */
    expect(decideDeletion({}).winner).toBe('delete')
  })
})
