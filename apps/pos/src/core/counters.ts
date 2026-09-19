import { claimRegister, type SqlDriver } from '@shopos/core'
import { chooseRegister } from './device'

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
 * The claim goes first. If the file write then fails, the shop holds a claim
 * for a counter this machine is not yet billing on — which is a counter the
 * others correctly leave alone, and this machine says plainly it could not
 * record the choice. The other order would leave a till billing on a counter it
 * never claimed, which is the collision this exists to prevent.
 */
export async function takeCounter(db: SqlDriver, registerId: string): Promise<boolean> {
  await claimRegister(db, { registerId })
  return await chooseRegister(registerId)
}
