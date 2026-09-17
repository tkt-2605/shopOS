import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A till that joins a shop must never set one up.
 *
 * This is the rule the whole second-till flow rests on, and it is invisible in
 * every screenshot. `firstRun` calls `bootstrap`, which mints a shop id, an
 * Admin role, a counter and a default price list. Run on a machine that is
 * about to join an existing shop, it produces a *second shop* — same names,
 * different rows, and no merge rule that can reconcile them. The handshake
 * refuses that pair with `DIFFERENT_SHOP`, correctly, after a day's takings are
 * already in the wrong database.
 *
 * The refusal is tested elsewhere. What is tested here is that the screen
 * cannot get a shopkeeper into that position: the join path and the set-up path
 * are two doors, and only one of them creates anything.
 *
 * A source rule rather than a rendering test, for the reason
 * `nothingClosesTheApp` is one — what matters is which function the code
 * reaches for, and a mocked `firstRun` returns whatever the mock returns
 * whichever door called it.
 */

/* From the working directory rather than `import.meta.url`: this project runs
   in jsdom, where the module URL is the dev server's http one and not a path.
   Vitest is configured at the repo root, so this is stable. */
const SRC = join(process.cwd(), 'apps', 'pos', 'src')

function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return everyFile(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8')
}

/** The two calls that bring a shop into being where there was none. */
const CREATES_A_SHOP = [/\bfirstRun\s*\(/, /\bbootstrap\s*\(/, /\bseedDemoData\s*\(/]

describe('the door that joins a shop', () => {
  it('does not call anything that creates one', () => {
    const joining = read('ui', 'JoinShop.tsx')
    for (const call of CREATES_A_SHOP) {
      expect(call.test(joining), `${call} is in JoinShop.tsx`).toBe(false)
    }
  })

  it('goes through the provider, which pairs and syncs and nothing else', () => {
    const provider = read('core', 'CoreProvider.tsx')
    const join = provider.slice(
      provider.indexOf('async function joinShop'),
      provider.indexOf('async function completeSetup'),
    )

    expect(join, 'joinShop was not found in CoreProvider').not.toBe('')
    expect(/\bpairWith\s*\(/.test(join), 'it pairs').toBe(true)
    expect(/\brunOnce\s*\(/.test(join), 'it pulls the shop').toBe(true)
    for (const call of CREATES_A_SHOP) {
      expect(call.test(join), `${call} is inside joinShop`).toBe(false)
    }
  })

  it('is offered on the first screen, not only after signing in', () => {
    /* The gap this closes. `SyncCard` has been able to join since sync was
       built, and it lives on the Settings screen -- behind a login, on a
       machine that has to have been set up to have a login at all. The only
       door on a new machine created a shop. */
    const app = read('App.tsx')
    expect(app.includes('<JoinShop')).toBe(true)
    expect(app.includes('JoinPanel')).toBe(true)
  })
})

describe('the first screen', () => {
  it('asks the network before it decides which door to lead with', () => {
    const app = read('App.tsx')
    expect(/lookAround\s*\(/.test(app), 'it looks for other tills').toBe(true)
  })

  it('still lets a second shop be set up deliberately', () => {
    /* Discovery decides which door is obvious and never decides for anybody: a
       shop opening a second branch on one network has to be able to say no. */
    const app = read('App.tsx')
    expect(app.includes('Set up a new shop')).toBe(true)
  })
})

describe('what a joining till is told about its counter', () => {
  it('asks which counter it is before it finishes', () => {
    /* A till with no counter of its own falls back to the first in the list,
       which is the one it just joined -- and two tills on one counter give two
       customers the same bill number. The next sync is refused with
       `SAME_REGISTER`, which is right, recoverable in ten seconds, and
       completely opaque to somebody who has never heard of a counter.

       So the flow asks, and the refusal it would otherwise have caused cannot
       happen. This is the assertion that fails if the step is dropped for
       being one screen too many. */
    const joining = read('ui', 'JoinShop.tsx')
    expect(/listRegisters\s*\(/.test(joining), 'it lists the shop’s counters').toBe(true)
    expect(/chooseRegister\s*\(/.test(joining), 'it records the choice').toBe(true)
  })
})
