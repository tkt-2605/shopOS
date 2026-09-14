/**
 * Which of two copies of a row wins, and whether anybody lost something.
 *
 * Pure, like `billTotals.ts` and `docFormat.ts` — it touches no database and
 * knows nothing about transport, so the rule can be argued with and tested on
 * its own rather than discovered inside a sync that has already overwritten
 * something. Phase 2 supplies the two rows; this decides.
 *
 * ── The rule, in order ─────────────────────────────────────────────────────
 *
 * 1. **Higher `rev` wins.** A revision only ever rises, and it rises on every
 *    local change — 019 made that a trigger rather than a convention, and 022
 *    extended it to a document whose lines changed. So a higher revision means
 *    strictly more edits have been applied to that copy.
 *
 * 2. **Equal revisions: the later `updated_at` wins.** Second and not first,
 *    because the two tills' clocks are not the same clock. A till whose clock is
 *    an hour slow would otherwise lose every disagreement it was ever in, and
 *    never say so. That is the whole reason `rev` exists.
 *
 * 3. **Still equal: the higher device id wins.** Arbitrary on purpose. What
 *    matters is not which till wins but that **both tills decide the same way**:
 *    a rule that resolves differently on the two machines leaves them
 *    permanently disagreeing, each certain it is right, and no further sync ever
 *    settles it. Comparing two ids both sides can see is the cheapest way to be
 *    sure they agree.
 *
 * ── What this cannot tell you, and does not pretend to ─────────────────────
 *
 * A higher `rev` does not prove the loser's edit was seen by the winner. Two
 * tills editing one price offline both raise it, and the lower one loses an edit
 * a person actually made. Knowing that properly needs a version vector per row,
 * which is a real cost on every table for a shop that mostly has one till.
 *
 * So `contested` is not guessed from the revisions. It is answered by the one
 * fact the transport genuinely has: whether **this row changed on both sides
 * since they last agreed**. Each till's changefeed says exactly that about its
 * own side, and a row in both feeds is a concurrent edit, certainly. That is
 * what `bothChangedSinceLastSync` carries, and it is the difference between a
 * sync that quietly drops somebody's work and one that can put it on a list.
 */

export type Side = 'mine' | 'theirs'

export interface Versioned {
  /** Absent on a table that carries no revision. Then rule 1 cannot apply. */
  rev?: number | null
  /** ISO 8601. Written by every service; the fallback when revisions tie. */
  updatedAt?: string | null
}

export interface MergeInput {
  mine: Versioned
  theirs: Versioned
  /** This machine's id, and the machine the other copy came from. */
  myDevice: string | null
  theirDevice: string | null
  /**
   * True when this row is in both tills' changefeeds since they last agreed —
   * which is a concurrent edit, and the only kind this can be certain about.
   */
  bothChangedSinceLastSync?: boolean
}

export type MergeReason =
  | 'higher_rev'
  | 'later_timestamp'
  | 'device_tiebreak'
  | 'identical'

export interface MergeDecision {
  winner: Side
  reason: MergeReason
  /**
   * Somebody's edit is being dropped and a person should be able to see that it
   * was. Never guessed — see the note above.
   */
  contested: boolean
  /** One line for the sync screen Phase 3 owes. */
  explain: string
}

export function decideRow(input: MergeInput): MergeDecision {
  const { mine, theirs } = input
  const contested = input.bothChangedSinceLastSync === true

  const myRev = numberOr(mine.rev)
  const theirRev = numberOr(theirs.rev)

  if (myRev !== null && theirRev !== null && myRev !== theirRev) {
    return decide(
      myRev > theirRev ? 'mine' : 'theirs',
      'higher_rev',
      contested,
      `revision ${Math.max(myRev, theirRev)} over ${Math.min(myRev, theirRev)}`,
    )
  }

  const mineAt = textOr(mine.updatedAt)
  const theirsAt = textOr(theirs.updatedAt)

  if (mineAt !== null && theirsAt !== null && mineAt !== theirsAt) {
    /* ISO 8601 in UTC compares correctly as text, which every service writes —
       `new Date().toISOString()`. A value that is not that shape would compare
       as nonsense rather than fail, so it is worth knowing that is the contract. */
    return decide(
      mineAt > theirsAt ? 'mine' : 'theirs',
      'later_timestamp',
      contested,
      `changed at ${later(mineAt, theirsAt)}, against ${earlier(mineAt, theirsAt)}`,
    )
  }

  // One side has a timestamp and the other does not: something is better than
  // nothing, and it is still the same answer on both machines.
  if (mineAt !== null && theirsAt === null) {
    return decide('mine', 'later_timestamp', contested, 'the other copy carries no time')
  }
  if (theirsAt !== null && mineAt === null) {
    return decide('theirs', 'later_timestamp', contested, 'this copy carries no time')
  }

  const myId = textOr(input.myDevice) ?? ''
  const theirId = textOr(input.theirDevice) ?? ''

  if (myId !== theirId) {
    return decide(
      myId > theirId ? 'mine' : 'theirs',
      'device_tiebreak',
      contested,
      'the same revision and the same moment, settled the same way on both tills',
    )
  }

  /* Indistinguishable. Keeping what is already here writes nothing, and writing
     nothing is always the safer of two answers that cannot be told apart. */
  return decide('mine', 'identical', false, 'the two copies are the same')
}

function decide(
  winner: Side, reason: MergeReason, contested: boolean, why: string,
): MergeDecision {
  const who = winner === 'mine' ? 'This till' : 'The other till'
  return {
    winner,
    reason,
    contested,
    explain: contested
      ? `${who} wins — ${why}. Both tills changed this since they last agreed, so an edit is being dropped.`
      : `${who} wins — ${why}.`,
  }
}

function numberOr(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function textOr(v: string | null | undefined): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

const later = (a: string, b: string) => (a > b ? a : b)
const earlier = (a: string, b: string) => (a > b ? b : a)

/**
 * A row that is gone on one side and present on the other.
 *
 * Deletion is not a value and has no revision to compare, so it gets its own
 * answer rather than being squeezed into the one above. **A delete wins over an
 * edit that did not know about it**, and the reason is which mistake is
 * recoverable: a row wrongly kept is deleted again in a second, and a row
 * wrongly deleted is gone with whatever was attached to it.
 *
 * The exception is a row the far side edited *after* the delete travelled, which
 * is not a disagreement at all — it is somebody deliberately bringing something
 * back — and the transport can only tell those apart with the revision the
 * deleting side last saw.
 */
export function decideDeletion(input: {
  deletedRev?: number | null
  survivingRev?: number | null
}): { winner: 'delete' | 'keep'; explain: string } {
  const gone = numberOr(input.deletedRev)
  const kept = numberOr(input.survivingRev)

  if (gone !== null && kept !== null && kept > gone) {
    return {
      winner: 'keep',
      explain: 'the other till changed this after it was deleted here, so it comes back',
    }
  }
  return {
    winner: 'delete',
    explain: 'deleted, and nothing has changed it since',
  }
}
