import type { PeerHealth } from '@shopos/core'
import { explainRefusal, looksLikeARefusal, isVersionGap, CLOCKS_WORTH_MENTIONING_MS } from './syncWords'

/**
 * The one question, and its one answer.
 *
 * What the screen offered before this was four facts in three places — `Closed.
 * Nothing can reach this till`, a column headed WAITING with a number under it,
 * a `not answering` badge, and `last agreed 4 minutes ago` — and left the
 * shopkeeper to assemble them. The question they actually have is whether the
 * tills are up to date, and it has a one-line answer.
 *
 * A pure function of the peer rows and the clock, in its own module for the
 * same reason as `syncNotice`: what it decides is easy to get subtly wrong, and
 * it can be got right here without a window, a port or a second machine.
 *
 * `waiting` is what **this** till still owes that one, and `behind` is what that
 * one has which this one has not seen. Both directions get said out loud and
 * neither stands in for the other: "95 changes still to pass on" and "the back
 * counter has 95 this till has not seen" send somebody to different machines,
 * and printing one when the other is true is worse than printing nothing.
 *
 * `behind` arrives from the peer's own `/hello` (migration 044). Until then this
 * screen could say what the till owed and never what it was owed — so it read
 * "Both tills have everything" while this machine was short, and every total on
 * every report was short with it.
 */
export interface SyncStatus {
  tone: 'ok' | 'warn' | 'plain'
  text: string
}

export function syncStatus(
  peers: PeerHealth[],
  now: number = Date.now(),
): SyncStatus {
  if (peers.length === 0) {
    return { tone: 'plain', text: 'This is the only till in this shop.' }
  }

  const naming = (p: PeerHealth): string => p.label ?? `till ${p.deviceId.slice(0, 8)}`

  /* A till that answered and said no. It outranks a silent one because it is
     the one somebody can actually fix, and because calling it unreachable sends
     them to look at a network that is working — this screen said "Cannot reach
     the back counter. Last agreed 1 hour ago" about a till that was replying to
     every request, and refusing every one. */
  const refused = peers.find((p) => p.lastError !== null && looksLikeARefusal(p.lastError))
  if (refused !== undefined) {
    return {
      tone: 'warn',
      /* A version gap is not the other till saying no: either side may be the
         one refusing, and the sentence says which one to update. */
      text: isVersionGap(refused.lastError!)
        ? `${naming(refused)}: ${explainRefusal(refused.lastError!)}`
        : `${naming(refused)} refused. ${explainRefusal(refused.lastError!)}`,
    }
  }

  /* Then unreachable. The useful part is *since when* — a till that dropped out
     a minute ago is a network hiccup, and one that dropped out at four o'clock
     went home. */
  const silent = peers.filter((p) => p.lastError !== null)
  if (silent.length > 0) {
    // The one that has been out of touch longest: the most alarming of them,
    // and the one whose "since when" is worth printing.
    const worst = silent.reduce((a, b) => (agreedBefore(a, b) ? a : b))
    const who = silent.length === 1
      ? naming(worst)
      : `${silent.length} tills`
    const owed = silent.reduce((n, p) => n + p.waiting, 0)
    const since = worst.lastAgreedAt === null
      ? 'It has never agreed with this one.'
      : `Last agreed ${ago(worst.lastAgreedAt, now)}.`
    return {
      tone: 'warn',
      text: owed === 0
        ? `Cannot reach ${who}. ${since}`
        : `Cannot reach ${who}. ${since} ${changes(owed)} still to reach it.`,
    }
  }

  /* Clocks first among the quiet problems, because it is the only one here that
     is silently costing edits rather than merely delaying them: the merge
     settles a tie on `updated_at`, so the slower till loses changes it genuinely
     made later and both screens go on saying everything agrees. */
  const adrift = peers.filter((p) => Math.abs(p.clockSkewMs) >= CLOCKS_WORTH_MENTIONING_MS)
  if (adrift.length > 0) {
    const worst = adrift.reduce((a, b) => (Math.abs(a.clockSkewMs) >= Math.abs(b.clockSkewMs) ? a : b))
    const minutes = Math.round(Math.abs(worst.clockSkewMs) / 60_000)
    return {
      tone: 'warn',
      text: `This till and ${naming(worst)} disagree about the time by about `
        + `${minutes} minute${minutes === 1 ? '' : 's'}. Set both clocks: at five `
        + 'minutes apart they stop talking, and before that the slower one quietly '
        + 'loses edits it made later.',
    }
  }

  const owed = peers.reduce((n, p) => n + p.waiting, 0)
  if (owed > 0) {
    const to = peers.length === 1 ? ` to ${naming(peers[0]!)}` : ''
    return { tone: 'plain', text: `${changes(owed)} still to pass on${to}.` }
  }

  /* Then what this till is short of, which is the half nothing could say until
     044 and the half a total on a screen depends on. Warn rather than plain: a
     figure short by somebody else's bills is wrong, whereas changes waiting to
     leave here are on their way. */
  const short = peers.filter((p) => (p.behind ?? 0) > 0)
  if (short.length > 0) {
    const worst = short.reduce((a, b) => ((a.behind ?? 0) >= (b.behind ?? 0) ? a : b))
    const missing = short.reduce((n, p) => n + (p.behind ?? 0), 0)
    return {
      tone: 'warn',
      text: short.length === 1
        ? `${naming(worst)} has ${missing} change${missing === 1 ? '' : 's'} this till has not seen.`
        : `${short.length} tills have ${missing} changes between them this till has not seen.`,
    }
  }

  /* Everything agreed. `lastAgreedAt` rather than `lastTriedAt`: a till that
     tried a second ago and agreed an hour ago is not up to date, and saying
     "checked just now" about it would be true and misleading. */
  const times = peers.map((p) => p.lastAgreedAt)
  // One till that has never agreed is enough to have no time worth printing:
  // the sentence covers all of them, so the claim has to be true of all of them.
  const oldest = times.some((t) => t === null)
    ? null
    : times.reduce((a, b) => (a! < b! ? a : b))
  const every = peers.length === 1 ? 'Both tills have' : 'Every till has'
  return {
    tone: 'ok',
    text: oldest === null
      ? `${every} everything.`
      : `${every} everything. Checked ${ago(oldest, now)}.`,
  }
}

function changes(n: number): string {
  return `${n} change${n === 1 ? '' : 's'}`
}

/** Never having agreed is older than any date there could be. */
function agreedBefore(a: PeerHealth, b: PeerHealth): boolean {
  if (a.lastAgreedAt === null) return true
  if (b.lastAgreedAt === null) return false
  return a.lastAgreedAt < b.lastAgreedAt
}

/** Shared with the peer table, which still shows a per-till time of its own. */
export function ago(at: string | null, now: number = Date.now()): string {
  if (at === null) return 'never'
  const seconds = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
