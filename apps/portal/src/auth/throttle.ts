/**
 * How many sign-in codes one address may ask for.
 *
 * The limits in `otp.ts` are per phone number: five an hour, one a minute.
 * They stop a number being used as a pager, and do nothing about one machine
 * asking for codes to a thousand different numbers -- which is how SMS gets
 * pumped at the sender's expense. So each address may start this many in an
 * hour, whatever numbers it asks for.
 *
 * In memory, because the portal is one process and a limit that forgets on a
 * restart costs at most one more hour's worth. The address is the socket's,
 * not a forwarded header: behind a proxy that would be the proxy's address,
 * and a header is whatever the caller cares to send.
 */

export const MAX_STARTS_PER_ADDRESS_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000

export class AddressThrottle {
  private readonly seen = new Map<string, number[]>()

  constructor(private readonly limit = MAX_STARTS_PER_ADDRESS_PER_HOUR) {}

  /**
   * Records a start from `address` and answers null, or the seconds until the
   * next one is allowed. An unknown address is not limited here: refusing
   * everyone because the socket could not say would lock the owner out.
   */
  take(address: string | null | undefined, now: Date): number | null {
    if (!address) return null
    const at = now.getTime()
    const recent = (this.seen.get(address) ?? []).filter((t) => at - t < HOUR_MS)
    if (recent.length >= this.limit) {
      this.seen.set(address, recent)
      return Math.max(1, Math.ceil((recent[0]! + HOUR_MS - at) / 1000))
    }
    recent.push(at)
    this.seen.set(address, recent)
    // Old addresses are dropped as they are passed, so the map does not grow for ever.
    if (this.seen.size > 10_000) {
      for (const [key, times] of this.seen) {
        if (times.every((t) => at - t >= HOUR_MS)) this.seen.delete(key)
      }
    }
    return null
  }
}
