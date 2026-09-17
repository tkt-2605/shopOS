import { describe, it, expect, afterEach } from 'vitest'
import { DEVICE_IDS, benchDir, drain, host, joiner, till, stopAll, writeProduct, revOf } from './bench.js'

/**
 * Three tills, all paired with each other, and a change that must stop moving.
 *
 * Migration 036 lets a till pass on what it was given, which is what makes a
 * hub work. It also makes a cycle possible for the first time: A tells B, B
 * tells C, and C is paired with A. The row arriving back at A is identical to
 * the one A already holds, so nothing should happen — and the reason that is
 * not automatic is `bump_rev` from 019, which fires `WHEN NEW.rev = OLD.rev`.
 * A write that changes nothing is exactly the write that raises the revision.
 *
 * Left alone, that is not a wasted round. It is a row whose revision climbs by
 * one every lap, on whichever till loses the tiebreak, for ever — and a shop
 * whose tills are all quietly disagreeing about which copy of a product is
 * newest.
 */

afterEach(stopAll)

async function mesh() {
  const front = await host()
  const back = await joiner()
  const side = await till({
    dataDir: benchDir(), deviceId: DEVICE_IDS.c, label: 'Side counter',
    registerPrefix: 'SD', seed: 'empty',
  })

  await back.pairWith(front)
  await drain(back, front)
  await back.claimRegister()

  await side.pairWith(front)
  await drain(side, front)
  await side.claimRegister()

  // The third pair, which is what makes this a ring rather than a hub.
  await side.pairWith(back)
  await drain(side, back)

  return { front, back, side }
}

describe('a change going round a ring of three tills', () => {
  it('comes to rest instead of climbing a revision every lap', async () => {
    const { front, back, side } = await mesh()

    const id = await front.as(() => writeProduct(front.db, { name: 'Notebook' }))
    const started = await revOf(front.db, id)

    // Round the ring, repeatedly, in both directions — which is what three
    // tills all running their own loop actually do.
    for (let lap = 0; lap < 4; lap += 1) {
      await drain(back, front)
      await drain(side, back)
      await drain(front, side)
      await drain(front, back)
      await drain(back, side)
      await drain(side, front)
    }

    expect(await revOf(front.db, id), 'the till that wrote it').toBe(started)
    expect(await revOf(back.db, id), 'the second counter').toBe(started)
    expect(await revOf(side.db, id), 'the third counter').toBe(started)
  })

  it('stops giving anybody anything to do', async () => {
    const { front, back, side } = await mesh()
    await front.as(() => writeProduct(front.db, { name: 'Pencil' }))

    for (let lap = 0; lap < 3; lap += 1) {
      await drain(back, front)
      await drain(side, back)
      await drain(front, side)
    }

    /* A round that keeps finding work is a ring that keeps circulating one
       row. Every pair, both ways, must now move nothing. */
    for (const [from, to] of [[back, front], [side, back], [front, side]] as const) {
      const round = await from.sync(to)
      expect(round.ok && round.received, `${from.label} <- ${to.label}`).toBe(0)
    }
  })
})
