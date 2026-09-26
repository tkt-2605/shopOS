import { tierFor, type Entitlement, type GatedFeature } from '@shopos/core'

/**
 * What the licence card says, in sentences a shopkeeper can act on.
 *
 * Kept away from the component because the words are the hard part and the
 * layout is not. Five of the six refusals below mean completely different
 * things and exactly one of them is the holder's fault, so a single "invalid
 * licence" message would turn a support call into an accusation — and in the
 * `UNKNOWN_KEY` case, an accusation aimed at somebody holding a perfectly
 * genuine licence whose till is simply out of date.
 *
 * The rule the sentences have to carry, and the one nobody will believe
 * without being told: **a lapsed licence does not stop the shop billing.**
 * Every message about lapsing says what still works, in the same breath as
 * what stopped. A shopkeeper who reads "your licence has expired" and closes
 * the till for the afternoon has lost a day's takings to a sentence.
 */

export interface LicenceLine {
  /** One line, the headline. */
  headline: string
  /** The sentence underneath. Empty when the headline says it all. */
  detail: string
  tone: 'ok' | 'warn' | 'bad'
}

/** `2027-03-31` as `31 March 2027`. A shopkeeper does not read ISO. */
export function prettyDate(iso: string | null): string {
  if (iso === null) return ''
  const at = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

const TIER_NAME: Record<string, string> = {
  single: 'One counter',
  multi: 'More counters',
  cloud: 'Cloud',
  branches: 'Branches',
}

export function tierName(tier: string): string {
  return TIER_NAME[tier] ?? tier
}

/**
 * What one licence in the list says about itself, in a few words.
 *
 * A shop can hold more than one, with different clocks: the counters were
 * bought once and do not expire, the cloud renews. So "does not expire" has to
 * be sayable next to a date, on the same card, without either looking wrong.
 */
export function grantLine(
  grant: { tier: string; state: string; paidThrough: string | null; graceUntil: string | null },
): string {
  if (grant.state === 'active') {
    return grant.paidThrough === null
      ? 'Bought outright. Does not expire.'
      : `Paid to ${prettyDate(grant.paidThrough)}.`
  }
  if (grant.state === 'grace') {
    return `Ran out ${prettyDate(grant.paidThrough)}. Still working until `
      + `${prettyDate(grant.graceUntil)}.`
  }
  if (grant.state === 'lapsed') return `Ran out ${prettyDate(grant.paidThrough)}.`
  return ''
}

/**
 * The card's headline and sentence, for whatever state the licence is in.
 *
 * `problem` is checked before `state`, because a token that will not verify
 * makes every other field meaningless — `entitlement` reports `state: 'none'`
 * alongside it, and "this till has no licence" is the wrong thing to say to
 * somebody who pasted one thirty seconds ago.
 */
export function licenceLine(e: Entitlement): LicenceLine {
  if (e.problem !== null) return problemLine(e)

  switch (e.state) {
    case 'none':
      return {
        headline: 'Free plan',
        detail: 'No licence code on this till. The counter works without one; a code adds '
          + 'more counters and tells us who you are.',
        tone: 'warn',
      }

    case 'active':
      return {
        headline: `${tierName(e.tier)} licence`,
        detail: e.paidThrough === null
          ? 'No renewal date. This licence does not expire.'
          : `Paid to ${prettyDate(e.paidThrough)}.`,
        tone: 'ok',
      }

    case 'grace':
      return {
        headline: `Your licence ran out on ${prettyDate(e.paidThrough)}`,
        /* Says what still works first. A shopkeeper who reads only the first
           half of this must not conclude anything has stopped, because
           nothing has. */
        detail: `Everything is still working. Renew by ${prettyDate(e.graceUntil)} and nothing changes at all.`,
        tone: 'warn',
      }

    case 'lapsed':
      return {
        headline: `Your licence ran out on ${prettyDate(e.paidThrough)}`,
        detail: 'Off-site backup and the phone view have stopped. Billing, printing, '
          + 'your own backups and the second counter are all unaffected.',
        tone: 'bad',
      }
  }
}

function problemLine(e: Entitlement): LicenceLine {
  switch (e.problem) {
    case 'MALFORMED':
      return {
        headline: 'That does not look like a licence code',
        detail: 'Check it was copied whole, with no line break in the middle.',
        tone: 'bad',
      }

    case 'BAD_SIGNATURE':
      /* Deliberately not "invalid" or "tampered with". The likeliest cause is
         a code that lost a character in a chat app, not somebody forging one,
         and accusing a customer of forgery is an expensive way to be right
         once in a hundred. */
      return {
        headline: 'This code did not check out',
        detail: 'It may have been altered on the way here. Ask for a fresh one.',
        tone: 'bad',
      }

    case 'UNKNOWN_KEY':
      /* The one that is not the holder's fault at all. A genuine licence,
         signed with a key newer than this build knows about. */
      return {
        headline: 'This till is too old to check that code',
        detail: 'The code is fine. Update ShopOS on this machine, then paste it again.',
        tone: 'warn',
      }

    case 'NOT_CONFIGURED':
      /* A build shipped without its public key. Nobody in a shop can fix
         this, so it says who can. */
      return {
        headline: 'This copy of ShopOS cannot check licence codes',
        detail: 'Nothing you can fix at the counter — please report it. The till is unaffected.',
        tone: 'bad',
      }

    case 'WRONG_SHOP':
      return {
        headline: 'That code belongs to a different shop',
        detail: 'Licences are issued to one shop. This can also happen after restoring '
          + 'a backup taken from another shop.',
        tone: 'bad',
      }

    default:
      return { headline: 'This licence could not be read', detail: '', tone: 'bad' }
  }
}

/**
 * The extra line about a clock that has been wound back.
 *
 * Shown beside whatever else the card says rather than instead of it, because
 * the licence reading is still the licence reading — the till simply cannot be
 * sure what day it is. Empty string means say nothing.
 */
export function clockLine(e: Entitlement): string {
  return e.clockUnreliable
    ? 'This machine’s date looks wrong — it is set earlier than a date this till has already seen. '
      + 'Dates on the licence may read oddly until it is corrected.'
    : ''
}

/** What a paste attempt that failed should say, reusing the same sentences. */
export function installProblem(
  code: string, shopId: string | null,
): LicenceLine {
  const line = problemLine({ problem: code } as Entitlement)
  if (code === 'WRONG_SHOP' && shopId !== null) {
    return { ...line, detail: `${line.detail} The code names shop ${shopId}.` }
  }
  return line
}

/**
 * The one-word state for the badge beside the plan name. The headline
 * underneath says the rest; this is what the eye lands on.
 */
export function stateWord(e: Entitlement): { word: string; tone: LicenceLine['tone'] | 'mute' } {
  if (e.problem !== null) return { word: 'Needs attention', tone: 'bad' }
  switch (e.state) {
    case 'none': return { word: 'Free', tone: 'mute' }
    case 'active': return { word: 'Active', tone: 'ok' }
    case 'grace': return { word: 'Renew soon', tone: 'warn' }
    case 'lapsed': return { word: 'Ran out', tone: 'bad' }
  }
}

export interface FeatureWords {
  /** The gate it answers to, or null for what every shop has for nothing. */
  gate: GatedFeature | null
  name: string
  note: string
  /**
   * Whether the product does this yet. A plan must not list as bought a
   * thing that does not exist; until it is built it says "Coming".
   */
  built: boolean
}

/**
 * What a shop gets, free and paid, in the order a shopkeeper cares about.
 *
 * The free rows are here on purpose. They are the rule every lapse message
 * carries -- nothing a shop needs to take money is ever sold -- said once as
 * a list instead of as a reassurance.
 */
export const FEATURES: readonly FeatureWords[] = [
  { gate: null, name: 'Billing, printing and returns', note: 'Always included.', built: true },
  { gate: null, name: 'Stock, credit and reports', note: 'Always included.', built: true },
  { gate: null, name: 'Backups on this computer', note: 'Always included.', built: true },
  { gate: 'multiTill', name: 'Add another counter', note: 'Tills that share one shop’s stock and bills.', built: true },
  { gate: 'cloudPeer', name: 'Off-site backup', note: 'A copy of the books kept away from the shop.', built: false },
  { gate: 'phoneView', name: 'Owner’s phone view', note: 'The day’s sales and stock on your phone.', built: false },
  { gate: 'diagnosticsUpload', name: 'Send a problem report', note: 'A till’s logs to us in one step.', built: false },
  { gate: 'branches', name: 'Branches', note: 'More than one shop under one owner.', built: false },
]

/** Which plan first includes a gated feature, as the name a shop sees. */
export function planFor(gate: GatedFeature): string {
  return tierName(tierFor(gate))
}
