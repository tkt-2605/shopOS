/**
 * A random number generator that gives the same answer twice.
 *
 * `Math.random()` would make every run of the scale tests a different shop, and
 * a performance test that fails once a fortnight on a shop nobody can rebuild
 * is worse than no test. Seeded, so a failure comes with the seed that
 * reproduces it.
 *
 * mulberry32: thirty-two bits of state, four operations, no dependency. It is
 * not cryptographic and has no business being anywhere near a key — this
 * generates shopping, and the only property it needs is that the sequence is
 * the same on every machine.
 */
export class Rand {
  #state: number

  constructor(seed: number) {
    // Zero is a fixed point of the mixing step: seeded with 0 it returns 0 for
    // ever. Every other seed is fine, and this one is the only trap.
    this.#state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0
  }

  /** In [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) | 0
    let t = this.#state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** An integer in [min, max], both ends included. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick from nothing')
    return items[Math.floor(this.next() * items.length)]!
  }
}
