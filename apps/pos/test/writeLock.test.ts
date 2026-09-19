import { describe, it, expect, vi } from 'vitest'
import { oneAtATime, serializingDriver, TILL_IS_BUSY } from '../src/core/writeLock'
import type { Row, SqlDriver, SqlValue, ExecResult, TxOptions } from '@shopos/core'

/**
 * The queue that stops a merge and a bill arriving at one connection together.
 *
 * Tested as a function rather than through the app, in the manner of
 * `syncStatus` and `syncNotice`: what can be got wrong here is ordering and
 * release, and neither needs a window, a port or a second machine.
 */

/**
 * Lets every queued microtask run.
 *
 * The gate awaits its predecessor before calling the work, so "has it started
 * yet" is several ticks away rather than one, and a single `await
 * Promise.resolve()` answers no about a writer that is merely about to begin.
 */
async function settled(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/**
 * Takes the rejection off a promise the moment it is made.
 *
 * `expect(p).rejects` does not attach its handler synchronously, so with fake
 * timers the clock can reach the rejection first and vitest reports it as an
 * unhandled error beside a test that otherwise passed.
 */
function caught(promise: Promise<unknown>): { error?: unknown } {
  const box: { error?: unknown } = {}
  promise.catch((err: unknown) => { box.error = err })
  return box
}

/** A promise somebody else decides the end of. */
function held<T = void>() {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

describe('one at a time', () => {
  it('does not let a second writer in while the first is still going', async () => {
    const take = oneAtATime()
    const first = held()
    const inside: string[] = []

    const a = take(async () => { inside.push('a in'); await first.promise; inside.push('a out') })
    const b = take(async () => { inside.push('b in') })

    await settled()
    expect(inside, 'b must not have started').toEqual(['a in'])

    first.settle()
    await Promise.all([a, b])
    expect(inside).toEqual(['a in', 'a out', 'b in'])
  })

  it('runs them in the order they arrived, not the order they woke up', async () => {
    const take = oneAtATime()
    const first = held()
    const order: number[] = []

    const all = [
      take(async () => { await first.promise; order.push(1) }),
      take(async () => { order.push(2) }),
      take(async () => { order.push(3) }),
      take(async () => { order.push(4) }),
    ]

    first.settle()
    await Promise.all(all)
    expect(order, 'a burst of nudges must not overtake the bill in front of them').toEqual([1, 2, 3, 4])
  })

  it('frees the queue when the writer in front throws', async () => {
    const take = oneAtATime()
    await expect(take(async () => { throw new Error('the disk is full') })).rejects.toThrow('the disk is full')
    await expect(take(async () => 'the next one still runs')).resolves.toBe('the next one still runs')
  })

  it('gives up waiting rather than hanging, and says why', async () => {
    vi.useFakeTimers()
    try {
      const take = oneAtATime(50)
      const first = held()
      const a = take(() => first.promise)
      const refused = caught(take(async () => 'never reached'))

      await vi.advanceTimersByTimeAsync(60)
      expect(refused.error).toBeInstanceOf(Error)
      expect((refused.error as Error).message).toBe(TILL_IS_BUSY)

      first.settle()
      await a
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let the writer behind a timed-out one start early', async () => {
    /* The trap in a gate with a timeout. Giving up the wait must not give up the
       place in the queue: whoever is ahead is still holding the connection, and
       releasing the slot on the way out would let the next writer in underneath
       them -- which is the exact collision this exists to prevent. */
    vi.useFakeTimers()
    try {
      const take = oneAtATime(50)
      const first = held()
      const running: string[] = []

      const a = take(async () => { running.push('a in'); await first.promise; running.push('a out') })
      const gaveUp = caught(take(async () => { running.push('never') }))

      await vi.advanceTimersByTimeAsync(60)
      expect((gaveUp.error as Error | undefined)?.message).toBe(TILL_IS_BUSY)

      /* Queued after the one that gave up, so its own wait starts fresh and the
         only thing that can hold it is `a` -- which is the point. Queued before
         the clock moved, it would simply have timed out alongside it and proved
         nothing about the ordering. */
      const c = take(async () => { running.push('c in') })
      await settled()
      expect(running, 'c must still be waiting on a, not on the one that gave up').toEqual(['a in'])

      first.settle()
      await vi.advanceTimersByTimeAsync(0)
      await Promise.all([a, c])
      expect(running).toEqual(['a in', 'a out', 'c in'])
    } finally {
      vi.useRealTimers()
    }
  })
})

/** A driver that records what reached it and can be held open mid-write. */
function recording(hold?: Promise<void>): SqlDriver & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async query<T = Row>(): Promise<T[]> { calls.push('query'); return [] },
    async get<T = Row>(): Promise<T | undefined> { calls.push('get'); return undefined },
    async queryValues(): Promise<SqlValue[][]> { calls.push('queryValues'); return [] },
    async execute(): Promise<ExecResult> {
      calls.push('execute in')
      if (hold) await hold
      calls.push('execute out')
      return { rowsAffected: 0 }
    },
    async transaction<T>(fn: (tx: SqlDriver) => Promise<T>, _opts?: TxOptions): Promise<T> {
      calls.push('tx in')
      if (hold) await hold
      const result = await fn(this as SqlDriver)
      calls.push('tx out')
      return result
    },
    async close(): Promise<void> { calls.push('close') },
  }
}

describe('the driver with the queue on it', () => {
  it('holds a second transaction until the first has committed', async () => {
    const open = held()
    const inner = recording(open.promise)
    const db = serializingDriver(inner)

    const a = db.transaction(async () => 'first')
    const b = db.transaction(async () => 'second')

    await settled()
    expect(inner.calls.filter((c) => c === 'tx in')).toHaveLength(1)

    open.settle()
    await Promise.all([a, b])
    expect(inner.calls).toEqual(['tx in', 'tx out', 'tx in', 'tx out'])
  })

  it('lets a read through while a write is running', async () => {
    /* `Db::query` allows reads during a transaction on purpose -- a merge can
       hold the connection for a minute and a counter that cannot read has
       stopped. Queueing them here would undo that decision quietly. */
    const open = held()
    const inner = recording(open.promise)
    const db = serializingDriver(inner)

    const writing = db.transaction(async () => 'held')
    await expect(db.query('SELECT 1')).resolves.toEqual([])
    await expect(db.get('SELECT 1')).resolves.toBeUndefined()
    await expect(db.queryValues('SELECT 1')).resolves.toEqual([])

    open.settle()
    await writing
  })

  it('queues a bare execute behind a transaction, rather than having it refused', async () => {
    /* The collision a cashier meets: `Db::execute` is refused outright while a
       transaction is open, so a write during a merge failed with a string nobody
       wrote for a shopkeeper. */
    const open = held()
    const inner = recording(open.promise)
    const db = serializingDriver(inner)

    const merging = db.transaction(async () => 'merge')
    const writing = db.execute('UPDATE settings SET value = ?', ['x'])

    await settled()
    expect(inner.calls).not.toContain('execute in')

    open.settle()
    await Promise.all([merging, writing])
    expect(inner.calls).toEqual(['tx in', 'tx out', 'execute in', 'execute out'])
  })
})
