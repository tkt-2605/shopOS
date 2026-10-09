import { SyncHttpError } from '@shopos/core'

/**
 * What a shopkeeper is told when two tills will not talk.
 *
 * Its own module because three places ask the same question and must not answer
 * it differently: the sync card in Settings, the join panel a machine sees
 * before it has a shop at all, and the one-line status. A refusal explained one
 * way on one screen and another way on another is a support call about which to
 * believe — and it was worse than that, because the wording used to live in two
 * functions: one screen said "The other till refused: The other till refused:
 * UNKNOWN_PEER", which is what two tables of the same thing looks like.
 *
 * Every sentence says what happened and what to do about it. `SAME_REGISTER` is
 * the one that earns its length -- it is recoverable in ten seconds, and the fix
 * is not guessable.
 */
const REFUSALS: Readonly<Record<string, string>> = {
  SCHEMA_MISMATCH:
    'The two tills are running different versions of ShopOS. Update them both '
    + 'before they exchange anything — this is refused rather than risked, because '
    + 'a half-understood row is worse than no row.',
  PEER_OUTDATED:
    'That till is on an older ShopOS than this one and has to be updated. Until '
    + 'it is, the two exchange nothing; both go on billing, and it all crosses '
    + 'once that till has the same version as this one.',
  THIS_TILL_OUTDATED:
    'This till is on an older ShopOS than that one. Update this machine; until '
    + 'then the two exchange nothing, and this till has stopped asking.',
  DIFFERENT_SHOP:
    'That till has a shop of its own. Two tills set up separately cannot be '
    + 'merged: each has its own staff, counters and price list under the same names. '
    + 'A second till has to be installed and left unset-up, then joined to this one.',
  NO_IDENTITY:
    'This machine could not record which machine it is, so it cannot be told '
    + 'apart from the other till. See the banner at the top of the screen.',
  SAME_DEVICE: 'That address is this same till.',
  SAME_REGISTER:
    'Both tills are billing on the same counter, so they would give two '
    + 'different customers the same bill number. Nothing has been exchanged. '
    + 'Open Counters and press "Use here" on the counter this machine actually '
    + 'sits at — the ones another till is already on cannot be picked.',
  WRONG_CODE:
    'That code was not right. One attempt uses a code up, so show a fresh '
    + 'one on the other till and try again.',
  NO_PAIRING_OFFERED:
    'The other till is not expecting anybody. Press "Add a till" on it first — '
    + 'it only listens for as long as somebody is standing there adding one.',
  ANOTHER_TILL_IS_ASKING:
    'Another machine is already asking to join that shop. Finish or refuse '
    + 'that one first — two at once is how the wrong till gets let in.',
  /* Not a fault and not a breakage, so it must not read like one. The other
     till is working perfectly; it is on the one-counter plan. */
  NEEDS_MULTI_TILL:
    'That shop is on the one-counter plan, so it cannot take a second till '
    + 'yet. Nothing is wrong with either machine — the counter already there '
    + 'goes on working exactly as before. Settings, Licence on that till shows '
    + 'the shop id to quote when you ask us for the multi-counter plan.',
  /* Tills join the main and nobody else. The other till is working; it is
     simply not the one to join. */
  NOT_THE_MAIN:
    'That till is not the shop’s main till, so it cannot let a till in. Join '
    + 'the main till instead — Settings, Two tills on any till in the shop says '
    + 'which one it is.',
  UNKNOWN_PEER: 'The other till does not know this one. Pair them again.',
  BAD_SIGNATURE: 'The other till would not accept this one. Pair them again.',
  NOT_READY:
    'The other till answered but was busy. It will be asked again on its own.',
  NOT_YOUR_BATCH:
    'The other till was sent something meant for a different till. Nothing has '
    + 'been exchanged; they will try again.',
  MALFORMED: 'The other till could not read what this one sent.',
  NO_SUCH_REQUEST:
    'The other till did not understand the request. It is probably running an '
    + 'older version of ShopOS.',
  /* Three that the protocol has always been able to answer with and that this
     table did not know, so they fell through to "The other till refused: STALE."
     — a code, printed at a shopkeeper, about a clock. */
  STALE:
    'The two tills disagree about the time by more than five minutes, so each '
    + 'is refusing the other as out of date. Check the clock on both machines; '
    + 'it is usually the one that has been off for a while and came back with a '
    + 'flat battery.',
  REPLAYED:
    'The other till had already seen that exact request, so it refused it a '
    + 'second time. Nothing was lost and the next round will carry it.',
  SERVER_ERROR:
    'Something went wrong on the other till while it was answering. Nothing has '
    + 'been exchanged. If it keeps happening, the Two tills card on that machine '
    + 'will say more.',
}

/**
 * What a record this till could not take is called on a screen.
 *
 * Here rather than in the card, for the reason at the top of this file: this
 * module is where a sync outcome is turned into a sentence, and a second copy
 * somewhere else is how two screens come to say different things about one
 * event.
 *
 * Not a refusal, and deliberately not in the table above. Nothing was refused
 * and both tills are working — it is a row the other machine holds and this one
 * could not write, which stays true until a person does something. So it says
 * what is true now rather than what went wrong, and it says the rest of the
 * sync went through, because the shape of this on a screen is otherwise
 * indistinguishable from a network fault.
 */
export function explainQuarantine(count: number): string {
  return (count === 1
    ? 'One thing the other till has could not be saved here.'
    : `${count} things the other till has could not be saved here.`)
    + ' The rest of the sync went through. This till tries again after every sync, so anything'
    + ' waiting for something still on its way comes in by itself; a name used twice needs one renamed.'
}

/**
 * How far apart two clocks can be before this is worth saying out loud.
 *
 * Half the tolerance, so the shop is told while the tills are still talking to
 * each other. At `CLOCK_TOLERANCE_MS` every request is refused and the screen
 * says `STALE`; a drift that is heading there is a thing somebody can fix in a
 * minute, and a refusal is a thing that has already stopped the shop.
 *
 * Skew matters for a second reason that has nothing to do with authentication:
 * the merge settles a tie on `updated_at`. Two tills three minutes apart are
 * two tills where the slower one loses edits it made later, quietly, and the
 * five-minute wall never comes near it.
 */
export const CLOCKS_WORTH_MENTIONING_MS = 2.5 * 60 * 1000


/**
 * Whether what was recorded against a peer is an answer or a silence.
 *
 * Both live in `last_error`: a protocol code when the far till answered and
 * refused, and whatever the socket said when it did not answer at all. They
 * want opposite sentences — "cannot reach the back counter" sends somebody to
 * look at a network that is working fine, while the till refuses every request.
 *
 * Told apart by the list above rather than by shape. Shape looks tempting,
 * since every code the protocol emits is shouted in snake case — and so is
 * `ECONNREFUSED`, which is precisely a till that did not answer. The protocol's
 * codes are a closed set, so the closed set is what this asks.
 */
/** The two refusals that are a version gap: one till has to be updated. */
export function isVersionGap(error: string): boolean {
  return error === 'PEER_OUTDATED' || error === 'THIS_TILL_OUTDATED'
}

export function looksLikeARefusal(error: string): boolean {
  const code = error.trim()
  return code in REFUSALS || /^HTTP_\d{3}$/.test(code)
}

export function explainRefusal(code: string): string {
  return REFUSALS[code.trim()] ?? `The other till refused: ${code}.`
}

export function explain(err: unknown): string {
  if (err instanceof SyncHttpError) return explainRefusal(err.code)
  return 'Could not reach that till. Check the address, and that it is switched on and '
    + `answering. ${String(err)}`
}
