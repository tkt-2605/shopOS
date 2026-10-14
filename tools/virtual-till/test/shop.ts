import { contents, disagreementsBetween, type Disagreement } from '../src/books.js'
import { benchDir, till } from './bench.js'
import type { Till } from '../src/till.js'

/**
 * N tills, any connection graph, and a way to ask whether they agree.
 *
 * `bench.ts` is deliberately two-shaped: a `host()`, a `joiner()`, and three
 * device ids with names. That is the right size for a scenario about one bug.
 * It is the wrong size for the question this package exists to answer, which
 * has no number in it:
 *
 * > Given N replicas, any connection graph, and any order of pairwise
 * > exchanges: once writing stops and every edge has carried at least once
 * > more, every replica holds identical state on every replicated table.
 *
 * Nothing here knows what a LAN is. An edge is a pair of tills that will
 * exchange with each other, and whether that exchange crosses a switch, the
 * internet, or nothing at all is a property of the transport underneath — which
 * is exactly why the acceptance criterion can be stated without naming one.
 */

/**
 * A device id for till `index`, stable across runs so a failing seed can be
 * reproduced and the output read.
 *
 * Deliberately outside the range `bench.ts` uses for its named three, so a file
 * can use both without two tills sharing an identity — which would not fail
 * loudly, it would merge two shops into one.
 */
export function deviceIdFor(index: number): string {
  const n = index.toString(16).padStart(4, '0')
  return `beef${n}-0000-4000-8000-${n.repeat(3)}`
}

/** A pair of tills that will exchange. Undirected; both ends may initiate. */
export type Edge = readonly [number, number]

export interface Shop {
  tills: Till[]
  edges: Edge[]
  /**
   * Rows that were already there before any till had spoken to any other:
   * per table, the ids a migration wrote. `disagreements` excuses their
   * timestamps, and nothing else.
   */
  seeded: Map<string, Set<string>>
}

export const topology = {
  /** Everyone talks to everyone. The most forgiving, and the most traffic. */
  mesh: (n: number): Edge[] =>
    range(n).flatMap((i) => range(n).filter((j) => j > i).map((j) => [i, j] as Edge)),

  /** One till in the middle. What a shop with a back office actually looks like. */
  star: (n: number): Edge[] => range(n).slice(1).map((i) => [0, i] as Edge),

  /** A chain. The shape that makes relaying load-bearing: 0 and n-1 never meet. */
  line: (n: number): Edge[] => range(n).slice(1).map((i) => [i - 1, i] as Edge),

  /** A chain closed into a loop, so a change can arrive from both directions. */
  ring: (n: number): Edge[] =>
    n < 3 ? topology.line(n) : [...topology.line(n), [n - 1, 0] as Edge],
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

/**
 * Starts `n` tills and pairs them along `edges`.
 *
 * Till 0 is the one that was set up; every other till is installed and empty,
 * which is what a till added to a real shop is. An empty till cannot be paired
 * *with* — there is no shop to join — so the pairing order is a traversal
 * outward from till 0, and a till joins through whichever neighbour reached it
 * first. In a line that means till 3 joins through till 2, never through till
 * 0, so the relaying in migration 036 is load-bearing from the first round
 * rather than only under test.
 *
 * Edges the traversal did not need are paired afterwards, when both ends
 * already hold the shop. A partition is not modelled here: every edge exists,
 * and whether it carries anything is the schedule's business.
 */
export async function openShop(n: number, edges: Edge[]): Promise<Shop> {
  const tills: Till[] = []
  for (let i = 0; i < n; i += 1) {
    tills.push(await till({
      dataDir: benchDir(),
      deviceId: deviceIdFor(i),
      label: `Till ${i}`,
      registerPrefix: `T${i.toString(36).toUpperCase()}`,
      seed: i === 0 ? 'shop' : 'empty',
    }))
  }

  /* Taken from a till that has only been migrated, before anything is paired.
     Whatever is in it was put there by a migration on that till alone. */
  const seeded = new Map<string, Set<string>>()
  for (const [table, rows] of await contents(tills[n - 1]!.db)) {
    seeded.set(table, new Set(rows.keys()))
  }

  const neighbours = new Map<number, number[]>(range(n).map((i) => [i, []]))
  for (const [a, b] of edges) {
    neighbours.get(a)!.push(b)
    neighbours.get(b)!.push(a)
  }

  const joined = new Set([0])
  const spanning = new Set<string>()
  const queue = [0]
  while (queue.length > 0) {
    const from = queue.shift()!
    for (const to of neighbours.get(from)!) {
      if (joined.has(to)) continue
      joined.add(to)
      spanning.add(key(from, to))
      await tills[to]!.pairWith(tills[from]!)
      await drainUntilQuiet(tills[to]!, tills[from]!)
      await tills[to]!.claimRegister()
      queue.push(to)
    }
  }
  if (joined.size !== n) {
    throw new Error(`till ${range(n).find((i) => !joined.has(i))} cannot reach the shop`)
  }

  for (const [a, b] of edges) {
    if (spanning.has(key(a, b))) continue
    await tills[b]!.pairWith(tills[a]!)
    await drainUntilQuiet(tills[b]!, tills[a]!)
  }

  return { tills, edges, seeded }
}

function key(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

/**
 * One till pulls from one peer until that peer has nothing more.
 *
 * `bench.ts`'s `drain` throws when a round is refused, which is right for a
 * scenario asserting that rounds succeed. Here a refusal is a legitimate
 * outcome of a random schedule — two tills on one counter, a peer mid-merge —
 * and stopping the exchange is the correct response to it. What must never
 * happen is the *quiet* failure: a round that reports success and moves
 * nothing while rows are still queued, which is 4.4 in the plan.
 */
export async function drainUntilQuiet(from: Till, to: Till, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    const round = await from.sync(to)
    if (!round.ok) return
    if (!round.more) return
  }
  throw new Error(`${from.label} still draining ${to.label} after ${rounds} rounds`)
}

/**
 * Every edge carries, in both directions, until a full pass moves nothing.
 *
 * This is the "and every edge has carried at least once more" half of the
 * criterion. A pass that keeps finding work is not a slow shop, it is a row
 * going round for ever — the thing `mesh-settles.test.ts` was written about —
 * so the pass count is capped and running out is a failure, not a timeout.
 */
export async function quiesce(shop: Shop, passes = 12): Promise<void> {
  const busiest: string[] = []
  for (let pass = 0; pass < passes; pass += 1) {
    let moved = 0
    busiest.length = 0
    for (const [a, b] of shop.edges) {
      for (const [from, to] of [[a, b], [b, a]] as const) {
        const round = await shop.tills[from]!.sync(shop.tills[to]!)
        if (round.ok && round.received > 0) {
          moved += round.received
          busiest.push(`${from} <- ${to}: ${round.received}`)
        }
        await drainUntilQuiet(shop.tills[from]!, shop.tills[to]!)
      }
    }
    if (moved === 0) return
  }
  /* Which rows, not just how many. A shop that never goes quiet is one row
     going round, and the name of that row is the whole of the diagnosis —
     followed by what each till's feed still says about it, which is the next
     question every time. */
  const apart = await disagreements(shop)
  const stuck = apart.slice(0, 5).map((d) => `${d.table}/${d.rowId} on ${d.till}: ${d.detail}`)
  const first = apart[0]
  if (first !== undefined) stuck.push(await feedSays(shop, first.table, first.rowId))
  throw new Error(
    `the shop never went quiet: ${passes} full passes still moving rows\n`
    + `last pass: ${busiest.join(', ')}\n`
    + (stuck.length === 0 ? 'and yet every till agrees' : `still apart:\n${stuck.join('\n')}`),
  )
}

export { contents, type Disagreement } from '../src/books.js'

/**
 * Every row on which some till holds something another one does not. The rule
 * is `disagreementsBetween`'s; this lines a shop's tills up for it, with the
 * rows its migrations seeded on each till for itself.
 */
export async function disagreements(shop: Shop): Promise<Disagreement[]> {
  const tills = []
  for (const [i, t] of shop.tills.entries()) {
    tills.push({ label: i === 0 ? 'till 0' : t.label, held: await contents(t.db) })
  }
  return disagreementsBetween(tills, shop.seeded)
}

/** What every till's feed still holds for one row. For the error above. */
async function feedSays(shop: Shop, table: string, rowId: string): Promise<string> {
  const said = await Promise.all(shop.tills.map(async (till) => {
    const entry = await till.db.get<{ op: string; deleted_rev: number | null; seq: number; origin_device: string | null }>(
      `SELECT op, deleted_rev, seq, origin_device FROM change_feed WHERE table_name = ? AND row_id = ?`,
      [table, rowId],
    )
    const cursors = await till.db.query<{ device_id: string; their_cursor: number; my_cursor: number }>(
      `SELECT device_id, their_cursor, my_cursor FROM sync_peers`,
    )
    return `${till.label}: feed=${entry ? `${entry.op}/rev${entry.deleted_rev}/seq${entry.seq}/from${String(entry.origin_device).slice(4, 8)}` : 'none'}`
      + ` read=${cursors.map((c) => `${c.device_id.slice(4, 8)}:${c.their_cursor}`).join(',')}`
  }))
  return said.join('\n      ')
}
