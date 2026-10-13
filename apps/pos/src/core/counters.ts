import {
  changeCounter, mainTill, pairedPeers, requestClaim,
  type ClaimAnswer, type ClaimAsk, type SqlDriver,
} from '@shopos/core'
import { chooseRegister } from './device'
import { syncFetch } from './syncFetch'
import { servingOn } from './syncHost'
import { nudgeSync } from './syncLoop'

export type CounterOutcome = { ok: true } | { ok: false; why: string }

/**
 * Taking a counter, which is two writes that must not come apart.
 *
 * One is `device.json`: which counter *this machine* bills on, kept beside the
 * database because it is a fact about the machine and no backup or restore
 * should carry it anywhere.
 *
 * The other is the counter's own row: which till sits here, kept in the shop's
 * books because every other till has to be able to see it. That is what stops a
 * second till being offered a counter that is already somebody's, and it works
 * through a hub and across a till that was switched off at the time, neither of
 * which a conversation between two tills can do.
 *
 * Both, from one function, because a screen that did one and forgot the other
 * would be a till billing on a counter nobody knows is taken, or a claim
 * against a till that is billing somewhere else. There is exactly one way to
 * pick a counter and this is it.
 *
 * On a till behind a main, the claim is the main's to grant and is asked for
 * live (`changeCounter` in core). With the main out of reach nothing changes
 * and this machine goes on billing where it was.
 *
 * The claim goes first. If the file write then fails, the shop holds a claim
 * for a counter this machine is not yet billing on — which is a counter the
 * others correctly leave alone, and this machine says plainly it could not
 * record the choice. The other order would leave a till billing on a counter it
 * never claimed, which is the collision this exists to prevent.
 */
export async function takeCounter(
  db: SqlDriver,
  registerId: string,
  opts: { take?: boolean } = {},
): Promise<CounterOutcome> {
  const answer = await changeCounter(db, { registerId, take: opts.take === true }, (ask) => askTheMain(db, ask))
  if (!answer.ok) return { ok: false, why: refusal(answer) }

  if (!(await chooseRegister(registerId))) {
    return {
      ok: false,
      why: 'This machine could not record which counter it is, so the choice was not made here. '
        + 'Billing is unaffected. The banner above says why.',
    }
  }
  // The main already holds the claim; the rest of the shop hears it sooner.
  nudgeSync(db)
  return { ok: true }
}

/** The main, asked over the same signed request every sync uses. */
async function askTheMain(db: SqlDriver, ask: ClaimAsk): Promise<ClaimAnswer> {
  const main = (await mainTill(db)).device
  const peer = (await pairedPeers(db)).find((p) => p.deviceId === main)
  if (peer === undefined) throw new Error('this till has no address for the main till')
  return requestClaim(peer, ask, syncFetch, { listenPort: (await servingOn())?.port ?? null })
}

function refusal(answer: Exclude<Awaited<ReturnType<typeof changeCounter>>, { ok: true }>): string {
  switch (answer.code) {
    case 'MAIN_UNREACHABLE':
      if (answer.error.includes('NO_SUCH_REQUEST')) {
        return 'The main till is on an older ShopOS that cannot hand out counters. '
          + 'Update the main till, then try again. This till goes on billing where it was.'
      }
      return 'The main till could not be reached, so the counter was not changed. '
        + 'A counter changes only while the main till is switched on and connected; '
        + 'this till goes on billing where it was.'
    case 'STILL_HELD': {
      const who = answer.label ?? 'Another till'
      const since = answer.at === null ? '' : `, last seen ${new Date(answer.at).toLocaleString()}`
      return `${who} is billing on that counter${since}. `
        + 'Two tills on one counter give two customers the same bill number, so the main till refused.'
    }
    case 'COUNTER_OFF':
      return 'That counter is switched off. Switch it on first.'
    case 'NO_SUCH_COUNTER':
      return 'The main till does not have that counter. Let this till sync, then try again.'
  }
}
