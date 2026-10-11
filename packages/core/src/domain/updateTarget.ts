/*
 * Which shops a release is for.
 *
 * Every till reads the same `latest.json` from the vendor's public releases
 * repository, so choosing shops cannot happen at the server: there is none.
 * The release carries a `shops` field and each till decides for itself, from
 * its shop id, whether the release is for it. A till that is held simply stays
 * on the version it has, exactly as if there were nothing new.
 *
 * Decided by the *shop*, never the till: a shop's tills share one shop id, so
 * they always decide alike and move together -- two tills of one shop split
 * across a release is what `update-rollout.md` step 4 exists to prevent.
 *
 * Shops are named by the first eight characters of their shop id, the same
 * short id that is on every report the shop sends and on its Licence screen.
 *
 * Pure and DB-free.
 */

export interface ReleaseTarget {
  /** Only these shops. Absent means every shop. */
  only?: string[]
  /** Never these shops, whatever else says. */
  hold?: string[]
  /** Of the shops not named, this share in 0..100. 0 halts the release. */
  percent?: number
}

export type ReleaseDecision =
  | { offer: true }
  | { offer: false; why: 'held' | 'not-listed' | 'not-yet' | 'halted' }

const SHORT = 8

/** The id a person reads off a report or the Licence screen. */
export function shortShopId(shopId: string): string {
  return shopId.replace(/[^0-9a-zA-Z]/g, '').slice(0, SHORT).toLowerCase()
}

function names(list: string[] | undefined, shop: string | null): boolean {
  if (!list || shop === null) return false
  return list.some((entry) => shortShopId(entry) === shop)
}

/**
 * A number in 0..99 for this shop and this version: the same on every till of
 * the shop, and different from one release to the next, so the shops that go
 * first are not always the same shops. FNV-1a; no secrecy is wanted, only a
 * spread.
 */
export function bucket(shopId: string, version: string): number {
  let hash = 0x811c9dc5
  for (const ch of `${shortShopId(shopId)}@${version}`) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 100
}

/**
 * Whether this release is for this shop.
 *
 * A shop that does not know its id yet is offered only what is offered to
 * everybody: a list or a share cannot name it, and leaving it out of a release
 * meant for every shop would strand it.
 */
export function releaseDecision(shopId: string | null, version: string, target: ReleaseTarget | null): ReleaseDecision {
  if (target === null) return { offer: true }
  const shop = shopId === null ? null : shortShopId(shopId)

  if (names(target.hold, shop)) return { offer: false, why: 'held' }
  if (names(target.only, shop)) return { offer: true }
  if (target.only !== undefined) return { offer: false, why: 'not-listed' }

  if (target.percent === undefined || target.percent >= 100) return { offer: true }
  if (target.percent <= 0) return { offer: false, why: 'halted' }
  if (shopId === null) return { offer: false, why: 'not-yet' }
  return bucket(shopId, version) < target.percent ? { offer: true } : { offer: false, why: 'not-yet' }
}

/**
 * The `shops` field of a `latest.json`, read defensively: the feed is a file
 * on the internet, and a malformed field must not stop a till updating. A
 * field that cannot be understood is treated as absent, which offers the
 * release -- the same as every release before targeting existed.
 */
export function readTarget(raw: unknown): ReleaseTarget | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const field = raw as Record<string, unknown>
  const list = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && shortShopId(v) !== '') : undefined

  const target: ReleaseTarget = {}
  const only = list(field['only'])
  const hold = list(field['hold'])
  if (only !== undefined) target.only = only
  if (hold !== undefined) target.hold = hold
  if (typeof field['percent'] === 'number' && Number.isFinite(field['percent'])) {
    target.percent = Math.max(0, Math.min(100, field['percent']))
  }
  return Object.keys(target).length === 0 ? null : target
}
