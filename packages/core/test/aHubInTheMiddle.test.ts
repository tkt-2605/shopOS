import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { collectChanges, applyBatch } from '../src/services/sync.js'
import { setDeviceId } from '../src/device.js'
import { freshDb, emptyDb, makeProduct } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * The shape Phase 6 plans: every till talks to one hub, and to nothing else.
 *
 * The feed records which peer a relayed row arrived *from*, not which till
 * wrote it, and a batch leaves out what came from the peer it is for. In a
 * star that is exactly enough: nothing is ever sent back where it came from.
 * The pre-release review read it the other way and called it a hop too far;
 * the extra hop exists only in a triangle, where a relayed row can reach a
 * till that also heard it directly -- and there it is an identical row, which
 * writes nothing. So the wire does not carry a true origin, and this is why.
 */

const A = '1111aaaa-1111-4111-8111-111111111111'
const HUB = '9999ffff-9999-4999-8999-999999999999'
const B = '2222bbbb-2222-4222-8222-222222222222'

afterEach(() => setDeviceId(null))

async function send(fromId: string, from: SqlDriver, toId: string, to: SqlDriver) {
  setDeviceId(fromId)
  const batch = await collectChanges(from, 0, 5000, toId)
  setDeviceId(toId)
  await applyBatch(to, batch, new Set())
  return batch
}

describe('a star with a hub in the middle', () => {
  it('carries a till\'s row to the others and never back to it', async () => {
    const a = (await freshDb()).db
    const hub = await emptyDb()
    const b = await emptyDb()
    await send(A, a, HUB, hub)
    await send(HUB, hub, B, b)

    setDeviceId(A)
    const id = await makeProduct(a, { name: 'Written at A' })
    await send(A, a, HUB, hub)
    const toB = await send(HUB, hub, B, b)
    expect(toB.records.some((r) => r.rowId === id), 'the hub relays it').toBe(true)

    setDeviceId(HUB)
    const backToA = await collectChanges(hub, 0, 5000, A)
    expect(backToA.records.some((r) => r.rowId === id), 'not back to the till that wrote it').toBe(false)
    setDeviceId(B)
    const backToHub = await collectChanges(b, 0, 5000, HUB)
    expect(backToHub.records.some((r) => r.rowId === id), 'nor back to the hub').toBe(false)

    for (const db of [a, hub, b]) await db.close()
  })
})

describe('a Turso database', () => {
  it('is a database the core runs on, and never replicates on its own', () => {
    /* libSQL's embedded replicas have their own sync, single-primary and
       last-write-wins by frame. A cloud peer that used it would skip the
       merge, the quarantine and the docstatus rules entirely. It is a
       `SqlDriver` behind `libsql-driver.ts`, and it syncs as a peer through
       `SyncTransport` like any till. */
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) { walk(path); continue }
        if (!/\.tsx?$/.test(name)) continue
        const text = readFileSync(path, 'utf8')
        if (/\bsyncUrl\b|\bsyncInterval\b|\.sync\(\s*\)/.test(text)) offenders.push(path)
      }
    }
    for (const root of ['packages/core/src', 'apps/pos/src', 'apps/portal/src']) walk(join(process.cwd(), root))
    expect(offenders).toEqual([])
  })
})
