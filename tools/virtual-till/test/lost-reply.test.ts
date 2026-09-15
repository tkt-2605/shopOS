import { describe, it, expect, afterEach } from 'vitest'
import { withFaults, ReplyLost } from '../src/faults.js'
import { host, joiner, stopAll, writeBill, billIds, countOf } from './bench.js'

/**
 * The far side committed and the near side never found out.
 *
 * This is the failure that duplicates money. Not a dropped request — nothing
 * happens then, and both sides agree nothing happened. This one: the batch
 * arrived, the rows were written, the cursor moved, and the *reply* was lost
 * on the way back. The sender has no way to tell that apart from "it never
 * arrived", so it must retry, and the retry must land on a till that has
 * already applied every row in it.
 *
 * If idempotency is keyed on a cursor the sender rewinds, this passes by
 * accident and fails in a shop the first time two rounds interleave. What has
 * to hold is that applying the same record twice is applying it once, because
 * the record carries its own identity.
 */

afterEach(stopAll)

describe('a reply that did not arrive', () => {
  it('does not duplicate the bill when the round is retried', async () => {
    const back = await joiner({
      transport: (inner) => withFaults(inner, { dropReplyAfterCommit: 1 }),
    })
    const front = await host()

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    const billId = await back.as(() =>
      writeBill(back.db, back.registerId!, { docNo: 'BBC/2627/00001' }))

    // The first push: the front counter writes it, then the reply is lost.
    const lost = await back.sync(front)
    expect(lost.ok).toBe(false)

    // It did arrive, despite the sender believing otherwise. That is the whole
    // premise of the scenario, so it is asserted rather than assumed.
    expect(await billIds(front.db)).toContain(billId)
    const afterFirst = await countOf(front.db, 'bills')

    // The retry, which the real sync loop makes ninety seconds later.
    const retried = await back.sync(front)
    expect(retried.ok).toBe(true)

    expect(await countOf(front.db, 'bills')).toBe(afterFirst)
    const rows = await front.db.query(`SELECT id FROM bills WHERE id = ?`, [billId])
    expect(rows).toHaveLength(1)
  })

  it('does not bump the row revision on the second application', async () => {
    const back = await joiner({
      transport: (inner) => withFaults(inner, { dropReplyAfterCommit: 1 }),
    })
    const front = await host()

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    const billId = await back.as(() =>
      writeBill(back.db, back.registerId!, { docNo: 'BBC/2627/00002' }))

    await back.sync(front)
    const first = await front.db.get<{ rev: number }>(
      `SELECT rev FROM bills WHERE id = ?`, [billId])

    await back.sync(front)
    const again = await front.db.get<{ rev: number }>(
      `SELECT rev FROM bills WHERE id = ?`, [billId])

    /* A re-applied row that increments `rev` is not merely untidy: `rev` is what
       the merge rule compares, so a till that bumps it on a replay has made its
       own copy look newer than the original and will overwrite a genuine later
       edit from the till that actually made one. */
    expect(again?.rev).toBe(first?.rev)
  })

  it('surfaces the lost reply as a failed round rather than a silent success', async () => {
    const back = await joiner({
      transport: (inner) => withFaults(inner, { dropReplyAfterCommit: 1 }),
    })
    const front = await host()

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()
    await back.as(() => writeBill(back.db, back.registerId!, { docNo: 'BBC/2627/00003' }))

    const round = await back.sync(front)

    // The till must not record the cursor as advanced on a round it never got
    // an answer to — that is how a batch gets skipped for ever.
    expect(round.ok).toBe(false)
    if (!round.ok) expect(round.code).toBeTruthy()
  })
})

describe('the fault injector itself', () => {
  it('is honest after its budget is spent', async () => {
    // A wrapper that kept throwing would make the scenarios above pass for the
    // wrong reason, so the count is asserted directly.
    let calls = 0
    const inner = {
      hello: async () => ({ deviceId: 'x', label: null, shopId: null, schemaVersion: 1, registerId: null, yourCursorWithThem: 0 }),
      fetch: async () => ({ fromDevice: 'x', schemaVersion: 1, records: [], upTo: 0, complete: true }),
      offer: async () => { calls += 1; return { upTo: 1 } },
    }
    const wrapped = withFaults(inner as never, { dropReplyAfterCommit: 1 })

    await expect(wrapped.offer({} as never)).rejects.toBeInstanceOf(ReplyLost)
    await expect(wrapped.offer({} as never)).resolves.toEqual({ upTo: 1 })
    expect(calls).toBe(2)
  })
})
