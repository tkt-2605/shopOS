/*
 * How often one caller may ask the web API for something that costs the
 * shop: a sign-in, an order.
 *
 * The portal's `AddressThrottle` (`apps/portal/src/auth/throttle.ts`), the
 * same sliding hour per key, kept here because core cannot import the portal.
 * In memory: the main is one process, and a limit that forgets on a restart
 * costs at most one more hour's worth.
 *
 * The key is Cloudflare's `cf-connecting-ip`, not the socket. The web port
 * listens on loopback and the only thing that can reach it is `cloudflared`,
 * so every socket is the same address; Cloudflare sets that header itself and
 * replaces whatever a caller sent in it.
 */

const HOUR_MS = 60 * 60 * 1000

export class HourlyThrottle {
  private readonly seen = new Map<string, number[]>()

  constructor(private readonly limit: number) {}

  /** Records a use by `key` and answers null, or the seconds until the next is allowed. */
  take(key: string | null | undefined, now: Date): number | null {
    if (!key) return null
    const at = now.getTime()
    const recent = (this.seen.get(key) ?? []).filter((t) => at - t < HOUR_MS)
    if (recent.length >= this.limit) {
      this.seen.set(key, recent)
      return Math.max(1, Math.ceil((recent[0]! + HOUR_MS - at) / 1000))
    }
    recent.push(at)
    this.seen.set(key, recent)
    if (this.seen.size > 10_000) {
      for (const [k, times] of this.seen) {
        if (times.every((t) => at - t >= HOUR_MS)) this.seen.delete(k)
      }
    }
    return null
  }
}
