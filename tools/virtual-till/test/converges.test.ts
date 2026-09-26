import { describe, it, expect, afterEach } from 'vitest'
import { newId, type SqlDriver } from '@shopos/core'
import { stopAll } from './bench.js'
import { openShop, quiesce, disagreements, topology, type Edge, type Shop } from './shop.js'
import type { Till } from '../src/till.js'

/**
 * The acceptance criterion, as something that can fail.
 *
 * > Given N replicas, any connection graph, and any order of pairwise
 * > exchanges: once writing stops and every edge has carried at least once
 * > more, every replica holds identical state on every replicated table.
 *
 * That sentence contains no number of tills, no LAN, no cloud and no phone, and
 * that is the point of it. Everything else in this package is a scenario about
 * one bug; this is the property the scenarios are in service of. If LAN turns
 * out not to be the road, this file does not change — the edges are pairwise
 * exchanges, and what carries them is the transport's business.
 *
 * Randomised rather than scripted, because a scripted order is a claim that the
 * author thought of the bad order. Every run is seeded and the seed is printed
 * on failure, so a failure is a failure you can have again.
 *
 * `mesh-settles.test.ts` was folded in here. It asked two questions of a fixed
 * ring of three — that a row going round does not climb a revision every lap,
 * and that the ring eventually stops circulating it — and both are what this
 * file asserts of any ring, and of every other shape, under an order nobody
 * chose: `disagreements` compares `rev` like any other column, and `quiesce`
 * fails the run if a full pass keeps finding work.
 */

const TILLS = 4
const SEEDS = [20260919, 7, 4242]

afterEach(stopAll)

/**
 * A small deterministic generator, so a failing run can be repeated exactly.
 *
 * `Math.random` would make this file a test that fails once a fortnight on
 * somebody else's machine with nothing to go on, which is worse than no test:
 * it teaches people to re-run the suite until it is green.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(random: () => number, xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!

/**
 * Writes of the three shapes the merge treats differently, so a run that only
 * ever creates rows cannot pass for a run that tests merging.
 *
 * Editing matters more than creating. Two tills that each add a product have
 * nothing to resolve — the union is the answer. Two tills that edit *the same*
 * product while out of touch are the case the whole revision rule exists for,
 * and they are the case a randomised schedule will not reach on its own unless
 * the write picks from what is already there.
 */
async function aWrite(shop: Shop, index: number, random: () => number, step: number): Promise<void> {
  const till = shop.tills[index]!
  const what = random()

  if (what < 0.3) {
    await till.as(() => newProduct(till.db, `Product ${index}-${step}`))
    return
  }
  if (what < 0.6) {
    const id = await someRow(till.db, 'products', random)
    if (id === null) return
    // A price change, which is the edit two counters really do make at once.
    await till.as(() => reprice(till.db, id, 1000 + Math.floor(random() * 90000)))
    return
  }
  if (what < 0.8) {
    await till.writeBill(`B${index}/${step}`, 1000 + Math.floor(random() * 90000))
    return
  }
  const id = await someRow(till.db, 'products', random)
  if (id === null) return
  // A removal, so the merge has to settle one of those against an edit too.
  await till.as(() => retire(till.db, id))
}

async function newProduct(db: SqlDriver, name: string): Promise<void> {
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
     VALUES (?, ?, 10000, 0, ?, ?)`,
    [newId(), name, now, now],
  )
}

async function reprice(db: SqlDriver, id: string, rate: number): Promise<void> {
  await db.execute(
    `UPDATE products SET base_rate = ?, updated_at = ? WHERE id = ?`,
    [rate, new Date().toISOString(), id],
  )
}

/**
 * A removal, the way a shop can actually perform one.
 *
 * Not `DELETE`. A row that is gone leaves nothing to compare, so a till that
 * has not heard yet offers it back and the two operations do not commute: a
 * till that saw the delete first has no row, one that saw the offer first has
 * one, and around a ring they take turns for ever. Migration 040 makes the case
 * that *can* be settled settle — a delete that meets a later edit — and says
 * plainly that this one cannot, because the tombstone is the feed entry and the
 * feed entry is pruned.
 *
 * A soft delete has no such problem. `deleted_at` is a column on a row that
 * stays, so a removal is an edit like any other and the revision rule already
 * settles it. Both are exercised: the scheduled runs use this, and the two
 * scenarios at the bottom of this file pin what a hard delete does and does not
 * manage.
 */
async function retire(db: SqlDriver, id: string): Promise<void> {
  await db.execute(
    `UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), new Date().toISOString(), id],
  )
}

async function someRow(db: SqlDriver, table: string, random: () => number): Promise<string | null> {
  const rows = await db.query<{ id: string }>(`SELECT id FROM "${table}" ORDER BY id`)
  return rows.length === 0 ? null : pick(random, rows).id
}

/**
 * A day's trading: writes on random tills, exchanges on random edges in random
 * directions, and some edges simply not carrying for a while — which is what a
 * partition is, from the merge's point of view.
 */
async function aBusyDay(shop: Shop, random: () => number, steps: number): Promise<void> {
  /* Roughly a third of the shop is out of touch to begin with. Chosen from the
     edge list rather than by unplugging a till, because an edge that stops
     carrying is the general case: it covers a switch going down, a till being
     asleep, and a phone that nobody can dial. */
  const cut = new Set(shop.edges.filter(() => random() < 0.35).map(String))
  const healAt = Math.floor(steps / 2)

  for (let step = 0; step < steps; step += 1) {
    if (step === healAt) cut.clear()

    await aWrite(shop, Math.floor(random() * shop.tills.length), random, step)

    if (random() < 0.7) {
      const edge = pick(random, shop.edges)
      if (cut.has(String(edge))) continue
      const [from, to] = random() < 0.5 ? edge : [edge[1], edge[0]] as Edge
      // One round, not a drain: a schedule where every exchange finishes is a
      // schedule that never leaves a till half caught up, which is the state
      // most of these bugs live in.
      await shop.tills[from]!.sync(shop.tills[to]!)
    }
  }
}

async function shouldAgree(shop: Shop): Promise<void> {
  await quiesce(shop)
  const found = await disagreements(shop)
  expect(found.map((d) => `${d.table}/${d.rowId} on ${d.till}: ${d.detail}`).join('\n')).toBe('')
}

describe('N tills, whatever the graph and whatever the order', () => {
  for (const shape of ['mesh', 'star', 'line', 'ring'] as const) {
    it(`converges on a ${shape}`, async () => {
      const shop = await openShop(TILLS, topology[shape](TILLS))
      await aBusyDay(shop, rng(SEEDS[0]!), 24)
      await shouldAgree(shop)
    }, 120_000)
  }

  for (const seed of SEEDS) {
    it(`converges under schedule ${seed}`, async () => {
      const shop = await openShop(TILLS, topology.ring(TILLS))
      await aBusyDay(shop, rng(seed), 30)
      await shouldAgree(shop)
    }, 120_000)
  }

  /**
   * Two tills either side of a line, which never exchange with each other at
   * all. Everything each of them learns about the other arrives through a till
   * in the middle that has no interest in the row — which is migration 036,
   * and which is also exactly what the cloud peer and a phone will be doing.
   */
  it('carries a row between two tills that never speak', async () => {
    const shop = await openShop(3, topology.line(3))
    const ends = [shop.tills[0]!, shop.tills[2]!]

    await ends[0]!.as(() => newProduct(ends[0]!.db, 'Only the front counter has this'))
    await ends[1]!.as(() => newProduct(ends[1]!.db, 'Only the side counter has this'))

    await shouldAgree(shop)
    for (const till of shop.tills) {
      expect(await countProducts(till.db), till.label).toBe(2)
    }
  }, 120_000)

  /**
   * One row, changed on every till while nothing was carrying.
   *
   * Agreement is most of the criterion but not all of it: four tills could
   * agree on a value none of them ever wrote, which is a merge inventing an
   * answer. So this pins both halves — everybody ends up holding the same
   * price, and the price is one somebody actually typed.
   */
  it('settles a row four tills changed at once, the same way on all of them', async () => {
    const shop = await openShop(TILLS, topology.ring(TILLS))
    const front = shop.tills[0]!
    const id = newId()
    await front.as(async () => {
      const now = new Date().toISOString()
      await front.db.execute(
        `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
         VALUES (?, 'Contested', 10000, 0, ?, ?)`,
        [id, now, now],
      )
    })
    await quiesce(shop)

    // Nothing carries while this happens. This is the partition.
    const typed = shop.tills.map((_, i) => 1000 * (i + 1))
    await Promise.all(shop.tills.map((till, i) => till.as(() => reprice(till.db, id, typed[i]!))))

    await shouldAgree(shop)

    const settled = await rateOf(front.db, id)
    expect(typed, `nobody typed ${settled}`).toContain(settled)
  }, 120_000)

  /**
   * A row removed outright rather than marked gone.
   *
   * The app does not do this — `products` is retired with `is_active`, a
   * supplier is archived, and the screens that genuinely delete are moving to
   * `deleted_at`. But raw deletes exist in migrations, in older builds, and in
   * whatever somebody types into a console at two in the morning, so the merge
   * has to make a reasonable job of one.
   *
   * On a line it settles: the delete travels outward, each till applies it
   * once, and nothing sends it back.
   */
  it('carries a row removed outright to the tills that had it', async () => {
    const shop = await openShop(3, topology.line(3))
    const front = shop.tills[0]!
    const id = newId()
    await front.as(() => newProductAs(front.db, id, 'Typed in by mistake'))
    await shouldAgree(shop)

    await front.as(() => front.db.execute(`DELETE FROM products WHERE id = ?`, [id]))
    await shouldAgree(shop)

    for (const till of shop.tills) {
      expect(await has(till.db, id), `${till.label} still holds it`).toBe(false)
    }
  }, 120_000)

  /**
   * The case migration 040 exists for.
   *
   * One till deletes a row while another, which has not heard, edits it. The
   * edit is somebody deliberately keeping the thing; the delete is somebody who
   * did not know that. `decideDeletion` has said so since it was written, and
   * until 040 it could not tell the two apart, because a deleted row leaves
   * nothing to read a revision off and the record crossed with `row: null`.
   */
  it('gives way to the edit that came after it', async () => {
    const shop = await openShop(4, topology.ring(4))
    const [front, , side] = shop.tills as [Till, Till, Till, Till]
    const id = newId()
    await front.as(() => newProductAs(front.db, id, 'Wanted after all'))
    await shouldAgree(shop)

    // Neither till has heard the other when it does this.
    await side.as(() => side.db.execute(
      `UPDATE products SET name = 'Wanted, and edited', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    ))
    await front.as(() => front.db.execute(`DELETE FROM products WHERE id = ?`, [id]))

    await shouldAgree(shop)
    for (const till of shop.tills) {
      expect(await has(till.db, id), `${till.label} brought it back`).toBe(true)
    }
  }, 120_000)
})

async function countProducts(db: SqlDriver): Promise<number> {
  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM products`)
  return row?.n ?? 0
}

async function rateOf(db: SqlDriver, id: string): Promise<number | undefined> {
  const row = await db.get<{ rate: number }>(`SELECT base_rate AS rate FROM products WHERE id = ?`, [id])
  return row?.rate
}

async function newProductAs(db: SqlDriver, id: string, name: string): Promise<void> {
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
     VALUES (?, ?, 10000, 0, ?, ?)`,
    [id, name, now, now],
  )
}

async function has(db: SqlDriver, id: string): Promise<boolean> {
  return (await db.get(`SELECT id FROM products WHERE id = ?`, [id])) !== undefined
}
