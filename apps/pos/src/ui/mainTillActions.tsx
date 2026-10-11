import { makeThisTheMain, handTheMainTo, type SqlDriver } from '@shopos/core'
import { keepTheDoorRight } from '../core/syncHost'
import { Card } from './components'
import { JoinShop } from './JoinShop'

/*
 * The three things a person can do about which till is the main, apart from
 * `SyncCard` so that card stays a card. Each asks first, says plainly what will
 * happen, and returns the sentence to show -- or null when the person said no.
 * Failures are thrown for the card to explain.
 */

type Ask = (message: string) => Promise<boolean>

/**
 * The main is gone, or the owner wants it here.
 *
 * Confirmed, because it is the one action that changes what every other till
 * does. Never automatic: see `makeThisTheMain` for why a two-till shop has to
 * switch by hand.
 */
export async function promoteHere(db: SqlDriver, actorId: string | undefined, ask: Ask): Promise<string | null> {
  const agreed = await ask(
    'Make this the main till?\n\n'
    + 'Do this when the main till is gone for good, or to move the main here. '
    + 'The other tills will need to be paired with this one: press Add a till '
    + 'here, then on each of them open Settings, Two tills, and press '
    + '"Pair with the new main till". They keep everything they hold.\n\n'
    + 'If the old main till comes back, it will see that this one is the main '
    + 'and step down on its own. Nothing it holds is lost.',
  )
  if (!agreed) return null
  await makeThisTheMain(db, actorId)
  await keepTheDoorRight(db)
  return 'This is now the main till. Pair the other tills with it.'
}

/**
 * The main hands its place to a till, while both are working.
 *
 * The gentle move: that till takes over the next time it catches up with this
 * one, and this one goes on passing bills between it and every other till
 * until each has been paired with the new main.
 */
export async function handTheMainOn(
  db: SqlDriver, to: { deviceId: string; name: string }, actorId: string | undefined, ask: Ask,
): Promise<string | null> {
  const who = to.name
  const agreed = await ask(
    `Make ${who} the main till?\n\n`
    + `${who} takes over the next time it catches up with this till. This till `
    + 'goes on passing bills between it and the other tills until each of them '
    + `has been paired with ${who}, so nothing stops in between.`,
  )
  if (!agreed) return null
  await handTheMainTo(db, to.deviceId, actorId)
  return `${who} will be the main till from its next catch-up.`
}

/**
 * Pairing with a main made after this till's main died: the join screen, in
 * the mode that keeps this till's books and counter and merges both ways.
 */
export function RejoinMainCard({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  return (
    <Card title="Pair with the new main till">
      <JoinShop rejoining onCancel={onCancel} onDone={onDone} />
    </Card>
  )
}
