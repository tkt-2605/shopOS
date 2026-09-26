import type { PeerHealth } from '@shopos/core'
import { ago } from './syncStatus'
import { looksLikeARefusal } from './syncWords'

/**
 * Whether a figure adding up the whole shop is actually adding up the whole shop.
 *
 * `syncStatus` answers "are the tills talking", which is a question about the
 * network and belongs on the Two tills card. This answers a different one, and
 * it is the one that matters on a screen showing money: **is this number all of
 * it**. The two come apart in both directions. Every till reachable and talking
 * still leaves this machine short of whatever the back counter rang up in the
 * last forty-five seconds. A till that is unreachable but had nothing to say is
 * not costing this total anything.
 *
 * Until migration 044 there was no way to tell. `PeerHealth` carried what this
 * till still owed and nothing about what it was owed, so a report could only
 * ever say "what this machine knows about" — and it did not say even that. It
 * printed a figure. The tax tab is filed off it.
 *
 * Null for a shop with one till, and that is not a special case being dodged:
 * a single till has everything by definition, and a line saying so on every
 * screen would be noise that teaches people to stop reading the line.
 */
export interface Completeness {
  complete: boolean
  text: string
}

export function completeness(peers: PeerHealth[], now: number = Date.now()): Completeness | null {
  if (peers.length === 0) return null

  const naming = (p: PeerHealth): string => p.label ?? `till ${p.deviceId.slice(0, 8)}`

  /* Short, and by how much. The strongest statement available and the only one
     with a number in it, so it goes first. */
  const short = peers.filter((p) => (p.behind ?? 0) > 0)
  if (short.length > 0) {
    const missing = short.reduce((n, p) => n + (p.behind ?? 0), 0)
    const who = short.length === 1 ? naming(short[0]!) : `${short.length} other tills`
    return {
      complete: false,
      text: `Short by ${missing} change${missing === 1 ? '' : 's'} from ${who}. `
        + 'This total does not include them.',
    }
  }

  /* Then a till nobody can reach. There is no number, because the number is on
     the machine that cannot be asked — which is exactly the point, and is why
     this says "since" rather than "by how much". A refusal is called out
     separately from a silence for the reason `syncWords` gives: they send
     somebody to different places. */
  const missing = peers.filter((p) => p.lastError !== null)
  if (missing.length > 0) {
    const worst = missing.reduce((a, b) => (agreedBefore(a, b) ? a : b))
    const who = missing.length === 1 ? naming(worst) : `${missing.length} tills`
    const why = looksLikeARefusal(worst.lastError!) ? 'refusing' : 'out of touch'
    const since = worst.lastAgreedAt === null
      ? `${who} has never reached this one — ${why}.`
      : `${who} has not been reached since ${ago(worst.lastAgreedAt, now)} — ${why}.`
    return {
      complete: false,
      text: `${since} Anything rung up there since is not in this.`,
    }
  }

  /* A peer that has never said how far its feed goes. An older build, and the
     honest answer is that this till cannot tell. Saying "everything" would be
     an invention and saying "short" would be a guess. */
  if (peers.some((p) => p.behind === null)) {
    const who = peers.filter((p) => p.behind === null).map(naming).join(', ')
    return {
      complete: false,
      text: `This till cannot tell whether it has everything from ${who}. `
        + 'Update ShopOS on that machine and it will say.',
    }
  }

  const times = peers.map((p) => p.lastAgreedAt)
  const oldest = times.some((t) => t === null)
    ? null
    : times.reduce((a, b) => (a! < b! ? a : b))
  return {
    complete: true,
    text: oldest === null
      ? 'Everything from every till.'
      : `Everything from every till, as of ${ago(oldest, now)}.`,
  }
}

/** Never having agreed is older than any date there could be. */
function agreedBefore(a: PeerHealth, b: PeerHealth): boolean {
  if (a.lastAgreedAt === null) return true
  if (b.lastAgreedAt === null) return false
  return a.lastAgreedAt < b.lastAgreedAt
}
