import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { Register, CounterTaken, TakeRegisterResult } from '@shopos/core'

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
let result: TakeRegisterResult = { ok: true }
let asked = 0
let tookWhich: string | null = null

vi.mock('@shopos/core', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  listRegisters: async () => rows,
  countersOtherTillsUse: async () => taken,
  resolveDeviceRegister: async () => null,
  takeRegister: async (_db: unknown, id: string) => { tookWhich = id; return result },
}))

vi.mock('../src/core/device', () => ({ chosenRegister: () => null }))
vi.mock('../src/core/counters', () => ({ takeCounter: async () => true }))
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

beforeEach(() => {
  rows = [counter()]
  taken = []
  result = { ok: true }
  asked = 0
  tookWhich = null
  vi.stubGlobal('confirm', () => { asked += 1; return true })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

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
    vi.stubGlobal('confirm', () => { asked += 1; return false })
    await show()

    await act(async () => {
      fireEvent.click(screen.getByText('Take it over'))
      await Promise.resolve()
    })

    expect(asked).toBe(1)
    expect(tookWhich, 'a refused confirmation must write nothing').toBeNull()
  })

  it('takes it when the answer is yes', async () => {
    taken = [heldBy()]
    await show()

    await act(async () => {
      fireEvent.click(screen.getByText('Take it over'))
      await Promise.resolve()
    })

    expect(tookWhich).toBe('front')
  })

  it('stands down when that till has started up since the screen was drawn', async () => {
    /* The list on screen may be a minute old. `takeRegister` checks again at
       the moment it writes, and a screen that ignored the refusal would put two
       tills on one counter on the strength of a stale render. */
    taken = [heldBy()]
    result = { ok: false, code: 'STILL_HELD', label: 'Back counter', at: null }
    await show()

    await act(async () => {
      fireEvent.click(screen.getByText('Take it over'))
      await Promise.resolve()
    })

    expect(document.body.textContent)
      .toContain('Back counter has started up since this screen was drawn')
    expect(document.body.textContent).toContain('Nothing was changed')
  })
})
