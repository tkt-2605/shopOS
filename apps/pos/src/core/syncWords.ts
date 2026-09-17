import { SyncHttpError } from '@shopos/core'

/**
 * What a shopkeeper is told when two tills will not talk.
 *
 * Its own module because two screens ask the same question and must not answer
 * it differently: the sync card in Settings, and the join panel a machine sees
 * before it has a shop at all. A refusal explained one way on one screen and
 * another way on the other is a support call about which one to believe.
 *
 * Every sentence says what happened and what to do about it. `SAME_REGISTER` is
 * the one that earns its length -- it is the refusal a second till gets by
 * default, it is recoverable in ten seconds, and the fix is not guessable.
 */
export function explainRefusal(code: string): string {
  switch (code) {
    case 'SCHEMA_MISMATCH':
      return 'The two tills are running different versions of ShopOS. Update them both '
        + 'before they exchange anything — this is refused rather than risked, because '
        + 'a half-understood row is worse than no row.'
    case 'DIFFERENT_SHOP':
      return 'That till has a shop of its own. Two tills set up separately cannot be '
        + 'merged: each has its own staff, counters and price list under the same names. '
        + 'A second till has to be installed and left unset-up, then joined to this one.'
    case 'NO_IDENTITY':
      return 'This machine could not record which machine it is, so it cannot be told '
        + 'apart from the other till. See the banner at the top of the screen.'
    case 'SAME_DEVICE':
      return 'That address is this same till.'
    case 'SAME_REGISTER':
      return 'Both tills are billing on the same counter, so they would give two '
        + 'different customers the same bill number. Nothing has been exchanged. '
        + 'Open Counters and press "Use here" on the counter this machine actually '
        + 'sits at — a till that has never been asked falls back to the first one '
        + 'in the list, which is the other till’s.'
    default:
      return `The other till refused: ${code}.`
  }
}

export function explain(err: unknown): string {
  if (err instanceof SyncHttpError) {
    switch (err.code) {
      case 'WRONG_CODE':
        return 'That code was not right. One attempt uses a code up, so show a fresh '
          + 'one on the other till and try again.'
      case 'NO_PAIRING_OFFERED':
        return 'The other till is not offering a code. Press "Show a pairing code" there first.'
      case 'UNKNOWN_PEER':
        return 'The other till does not know this one. Pair them again.'
      case 'BAD_SIGNATURE':
        return 'The other till would not accept this one. Pair them again.'
      default:
        return explainRefusal(err.code)
    }
  }
  return 'Could not reach that till. Check the address, and that it is switched on and '
    + `answering. ${String(err)}`
}
