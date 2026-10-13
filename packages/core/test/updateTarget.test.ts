import { describe, it, expect } from 'vitest'
import { bucket, readTarget, releaseDecision, shortShopId } from '../src/domain/updateTarget'

const TRT = '01a1256f-3b1b-4f79-b255-4d86f4a64e3c'
const OTHER = '51c78eec-027f-44eb-8500-d7787886ac04'

describe('which shops a release is for', () => {
  it('is every shop when the release names none', () => {
    expect(releaseDecision(TRT, '0.3.0', null)).toEqual({ offer: true })
    expect(releaseDecision(null, '0.3.0', null)).toEqual({ offer: true })
  })

  it('names a shop by the short id on its reports', () => {
    expect(shortShopId(TRT)).toBe('01a1256f')
    const target = { only: ['01a1256f'] }
    expect(releaseDecision(TRT, '0.3.0', target)).toEqual({ offer: true })
    expect(releaseDecision(OTHER, '0.3.0', target)).toEqual({ offer: false, why: 'not-listed' })
  })

  it('accepts a whole shop id, or one in capitals, as the same shop', () => {
    expect(releaseDecision(TRT, '0.3.0', { only: [TRT] })).toEqual({ offer: true })
    expect(releaseDecision(TRT, '0.3.0', { only: ['01A1256F'] })).toEqual({ offer: true })
  })

  it('holds a shop back whatever else the release says', () => {
    expect(releaseDecision(TRT, '0.3.0', { only: ['01a1256f'], hold: ['01a1256f'] }))
      .toEqual({ offer: false, why: 'held' })
    expect(releaseDecision(TRT, '0.3.0', { hold: ['01a1256f'] })).toEqual({ offer: false, why: 'held' })
    expect(releaseDecision(OTHER, '0.3.0', { hold: ['01a1256f'] })).toEqual({ offer: true })
  })

  it('halts at 0% and is everybody at 100%', () => {
    expect(releaseDecision(TRT, '0.3.0', { percent: 0 })).toEqual({ offer: false, why: 'halted' })
    expect(releaseDecision(TRT, '0.3.0', { percent: 100 })).toEqual({ offer: true })
  })

  it('lets a listed shop in even while the release is halted for the rest', () => {
    expect(releaseDecision(TRT, '0.3.0', { only: ['01a1256f'], percent: 0 })).toEqual({ offer: true })
  })

  it('gives a share the same answer on every till of a shop', () => {
    // Two tills of one shop carry the same shop id; the answer cannot differ.
    const a = releaseDecision(TRT, '0.3.0', { percent: 50 })
    const b = releaseDecision(TRT, '0.3.0', { percent: 50 })
    expect(a).toEqual(b)
  })

  it('spreads a share over shops, and moves it between releases', () => {
    const shops = Array.from({ length: 2000 }, (_, i) => `${i.toString(16).padStart(8, '0')}-shop`)
    const offered = shops.filter((s) => releaseDecision(s, '0.3.0', { percent: 25 }).offer).length
    expect(offered).toBeGreaterThan(400)
    expect(offered).toBeLessThan(600)
    const differs = shops.some((s) => bucket(s, '0.3.0') !== bucket(s, '0.3.1'))
    expect(differs).toBe(true)
  })

  it('does not strand a shop that does not know its id, unless the release is limited', () => {
    expect(releaseDecision(null, '0.3.0', { hold: ['01a1256f'] })).toEqual({ offer: true })
    expect(releaseDecision(null, '0.3.0', { only: ['01a1256f'] })).toEqual({ offer: false, why: 'not-listed' })
    expect(releaseDecision(null, '0.3.0', { percent: 50 })).toEqual({ offer: false, why: 'not-yet' })
  })
})

describe('the shops field of latest.json', () => {
  it('is read when it is well formed', () => {
    expect(readTarget({ only: ['01a1256f'], hold: ['51c78eec'], percent: 30 }))
      .toEqual({ only: ['01a1256f'], hold: ['51c78eec'], percent: 30 })
  })

  it('is treated as absent when it cannot be understood, so the update is still offered', () => {
    for (const raw of [undefined, null, 'all', 7, [], {}, { only: 'x' }, { percent: 'half' }]) {
      expect(readTarget(raw)).toBeNull()
    }
  })

  it('drops entries that are not shop ids and clamps the share', () => {
    expect(readTarget({ only: ['01a1256f', 5, '', '--'], percent: 250 })).toEqual({ only: ['01a1256f'], percent: 100 })
  })
})
