import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

/**
 * The button that lets a restored machine bill again.
 *
 * `aTillThatIsGone.test.ts` proves the core of this against a real database:
 * a claim held by a device id nobody answers to is a ghost, clearing it lets
 * `resolveDeviceRegister` hand the counter back. What that test cannot say is
 * whether anything on any screen ever calls it — and a shop whose machine
 * cannot ring up a sale is not helped by a function nothing presses.
 *
 * This is the wiring, and it is worth its own file because the failure it
 * catches is silent: the panel renders, the sentence is right, the button does
 * nothing, and the shopkeeper concludes the software is broken. Which it would
 * be.
 */

let ghosts: unknown[] = []
let cleared = 0
let reloaded = 0

vi.mock('@shopos/core', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  ghostClaims: async () => ghosts,
  clearGhostClaims: async () => { cleared += 1; ghosts = []; return 1 },
}))

// One object, so the component's effect does not re-run on every render.
const core = { db: {}, reloadRegister: async () => { reloaded += 1 } }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))

const { FreeGhostClaims } = await import('../src/ui/FreeGhostClaims')

async function show() {
  render(<FreeGhostClaims />)
  await act(async () => { await Promise.resolve() })
}

async function press(label: string) {
  await act(async () => {
    fireEvent.click(screen.getByText(label))
    await Promise.resolve()
  })
}

beforeEach(() => { ghosts = []; cleared = 0; reloaded = 0 })
afterEach(cleanup)

describe('counters held by a till that no longer exists', () => {
  it('says nothing when there are none, which is every ordinary day', async () => {
    await show()
    expect(document.body.textContent).toBe('')
  })

  it('says what happened, in the one sentence that explains it', async () => {
    ghosts = [{}]
    await show()

    const said = document.body.textContent ?? ''
    expect(said).toContain('One counter in this shop is claimed by a till that no longer exists')
    /* The cause, because without it this reads as a fault rather than as a
       consequence of the thing they did five minutes ago. */
    expect(said).toContain('after a restore')
  })

  it('counts them when there is more than one', async () => {
    ghosts = [{}, {}, {}]
    await show()
    expect(document.body.textContent).toContain('3 counters')
  })

  it('actually frees them when the button is pressed', async () => {
    ghosts = [{}]
    await show()
    await press('Free them')

    expect(cleared, 'the button is wired to the thing').toBe(1)
  })

  it('tells the machine to look at its counter again, without a restart', async () => {
    /* `resolveDeviceRegister` has already run and already returned null. Without
       this the counters are free, the screen says so, and the till still cannot
       bill until somebody closes and reopens the app. */
    ghosts = [{}]
    await show()
    await press('Free them')

    expect(reloaded).toBe(1)
  })

  it('says what to do next rather than simply vanishing', async () => {
    /* A panel that disappears on success has told the shopkeeper nothing. The
       counter is free; somebody still has to pick it. */
    ghosts = [{}]
    await show()
    await press('Free them')

    const said = document.body.textContent ?? ''
    expect(said).toContain('Those counters are free')
    expect(said).toContain('Use here')
  })
})
