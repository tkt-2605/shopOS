import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { Register, CounterTaken } from '@shopos/core'
import type { CounterOutcome } from '../src/core/counters'

/**
 * Taking a counter back from a till that has stopped starting up.
 *
 * `aTillThatIsGone.test.ts` decides when a claim is stale and what happens when
 * one is taken. This decides whether the screen ever offers it, what it says
 * while offering, and — the part that matters most — that it asks first.
 *
 * The cost of getting this wrong is not a broken screen. Two tills on one
 * counter mint invoice numbers from the same series, so a button that took a
 * counter without asking would hand two customers the same bill number, and the
 * first anybody would know of it is a rejected e-invoice.
 */

let rows: Register[] = []
let taken: CounterTaken[] = []
let result: CounterOutcome = { ok: true }
let tookWhich: string | null = null
let tookOver = false

vi.mock('@shopos/core', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  listRegisters: async () => rows,
  countersOtherTillsUse: async () => taken,
  resolveDeviceRegister: async () => null,
}))

vi.mock('../src/core/device', () => ({ chosenRegister: () => null }))
/* Taking it over is asked of the main, through the one way a counter is
   taken (`takeCounter`); the screen's part is to ask the person first and to
   say what the main answered. */
vi.mock('../src/core/counters', () => ({
  takeCounter: async (_db: unknown, id: string, opts: { take?: boolean } = {}) => {
    tookWhich = id
    tookOver = opts.take === true
    return result
  },
}))
vi.mock('../src/core/useShopChanged', () => ({ useShopChanged: () => {} }))

const core = { db: {}, reloadRegister: async () => {} }
vi.mock('../src/core/CoreProvider', () => ({
  useCore: () => core,
  useUser: () => ({ id: 'a-user' }),
}))

const Registers = (await import('../src/pages/Registers')).default

const DAY = 24 * 60 * 60 * 1000

function counter(over: Partial<Register> = {}): Register {
  return {
    id: 'front', name: 'Front counter', prefix: 'FR',
    isActive: true, hasOpenSession: false, ...over,
  }
}

function heldBy(over: Partial<CounterTaken> = {}): CounterTaken {
  return {
    registerId: 'front', deviceId: 'the-back-till', label: 'Back counter',
    at: new Date(Date.now() - 5 * DAY).toISOString(), stale: true, ...over,
  }
}

async function show() {
  render(<Registers />)
  await act(async () => { await Promise.resolve() })
}

/**
 * The dialog the app draws, rather than the one the browser used to.
 *
 * This test stubbed `window.confirm` and passed, while the real screen was not
 * asking at all: Tauri replaces `window.confirm` in the webview with an async
 * shim, the guard was written `const agreed = window.confirm(...)` with no
 * await, and a promise is always truthy. So a counter another till was billing
 * on could be taken with one click and no question -- which the message in that
 * very dialog says gives two customers the same bill number.
 *
 * `useConfirm` exists for exactly this and this screen had not adopted it. The
 * question is now found and answered the way a person would, which is also the
 * only version of this test that could have failed.
 */
async function answer(yes: boolean) {
  const dialog = await screen.findByRole('dialog')
  const button = Array.from(dialog.querySelectorAll('button'))
    .find((b) => b.textContent === (yes ? 'Yes, go ahead' : 'No, leave it'))
  if (!button) throw new Error('the confirmation had no button to press')
  await act(async () => {
    fireEvent.click(button)
    await Promise.resolve()
  })
}

/** Whether a question is on screen at all. */
function asking(): boolean {
  return screen.queryByRole('dialog') !== null
}


beforeEach(() => {
  rows = [counter()]
  taken = []
  result = { ok: true }
  tookWhich = null
  tookOver = false
})

afterEach(() => cleanup())

describe('a counter another till is holding', () => {
  it('is refused outright while that till is still starting up', async () => {
    taken = [heldBy({ stale: false, at: new Date().toISOString() })]
    await show()

    expect(document.body.textContent).toContain('Back counter bills here')
    expect(screen.queryByText('Take it over'), 'no offer while it is genuinely theirs')
      .toBeNull()
  })

  it('is offered once nobody has renewed it for long enough', async () => {
    taken = [heldBy()]
    await show()

    expect(screen.getByText('Take it over')).toBeTruthy()
  })

  it('names the till and says when, because "claimed" is not a question anybody can answer', async () => {
    taken = [heldBy()]
    await show()

    expect(document.body.textContent).toContain('Back counter, last seen 5 days ago')
  })

  it('says so plainly when the holder has never renewed at all', async () => {
    // Every claim made before migration 045, and every claim on a backup.
    taken = [heldBy({ at: null })]
    await show()

    expect(document.body.textContent)
      .toContain('Back counter claimed this and has not been seen since')
  })

  it('asks before taking it, and does nothing if the answer is no', async () => {
    taken = [heldBy()]
    await show()

    await act(async () => {
      fireEvent.click(screen.getByText('Take it over'))
      await Promise.resolve()
    })

    expect(asking(), 'a question, before anything is written').toBe(true)
    expect(tookWhich, 'and nothing written while it is open').toBeNull()

    await answer(false)
    expect(tookWhich, 'a refused confirmation must write nothing').toBeNull()
  })

  it('takes it when the answer is yes', async () => {
    taken = [heldBy()]
    await show()

    await act(async () => {
      fireEvent.click(screen.getByText('Take it over'))
      await Promise.resolve()
    })
    await answer(true)

    expect(tookWhich).toBe('front')
    expect(tookOver, 'asked as a take-over, which the main checks is stale').toBe(true)
  })

  it('stands down when the main says no', async () => {
    /* The list on screen may be a minute old, and the main checks the claim
       against its own record before it grants it -- the holder may have
       started up since, or the main may be out of reach. A screen that
       ignored the refusal would put two tills on one counter on the strength
       of a stale render. */
    taken = [heldBy()]
    result = { ok: false, why: 'Back counter is billing on that counter. The main till refused.' }
    await show()

    await act(async () => {
      fireEvent.click(screen.getByText('Take it over'))
      await Promise.resolve()
    })
    await answer(true)

    expect(document.body.textContent).toContain('Back counter is billing on that counter. The main till refused.')
    expect(document.body.textContent).not.toContain('now bills on that counter')
  })
})
