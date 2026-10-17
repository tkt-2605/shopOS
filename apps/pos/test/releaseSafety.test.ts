import { describe, it, expect } from 'vitest'
import {
  widens, crashGate, hotfixProblems, shopsFromTagMessage, RUNS_TO_JUDGE, type ReleaseFigures,
} from '../../../tools/release'

/**
 * Release safety in `tools/release.ts`: a rollout is not widened while the
 * release crashes more than the one before it, narrowing is never held up,
 * and a hotfix is cut from the release it fixes and goes first to the shop
 * that needed it.
 */

const fig = (version: string, clean: number, panicked: number, tills = 5): ReleaseFigures =>
  ({ version, tills, clean, panicked, crashFree: clean + panicked === 0 ? null : clean / (clean + panicked) })

describe('widening a rollout', () => {
  it('knows wider from narrower', () => {
    expect(widens({ only: ['aaaaaaaa'] }, { percent: 10 })).toBe(true)
    expect(widens({ percent: 10 }, { percent: 50 })).toBe(true)
    expect(widens({ percent: 50 }, null)).toBe(true)
    expect(widens({ only: ['aaaaaaaa'] }, { only: ['aaaaaaaa', 'bbbbbbbb'] })).toBe(true)
    expect(widens({ percent: 50 }, { percent: 10 })).toBe(false)
    expect(widens({ percent: 50 }, { percent: 0 })).toBe(false)
    expect(widens(null, { percent: 0 })).toBe(false)
  })
})

describe('the crash gate', () => {
  it('holds a release that crashes noticeably more than the one before it', () => {
    const gate = crashGate([fig('0.3.0', 90, 10), fig('0.2.21', 99, 1)], '0.3.0')
    expect(gate.ok).toBe(false)
    expect(gate.said).toContain('90.0% crash-free')
    expect(gate.said).toContain('99.0% for 0.2.21')
  })

  it('lets through one about as good, or better', () => {
    expect(crashGate([fig('0.3.0', 98, 2), fig('0.2.21', 99, 1)], '0.3.0').ok).toBe(true)
    expect(crashGate([fig('0.3.0', 100, 0), fig('0.2.21', 95, 5)], '0.3.0').ok).toBe(true)
  })

  it('does not judge on too few runs, and says so', () => {
    const gate = crashGate([fig('0.3.0', RUNS_TO_JUDGE - 10, 5), fig('0.2.21', 99, 1)], '0.3.0')
    expect(gate.ok).toBe(true)
    expect(gate.said).toMatch(/too few to judge/)
  })

  it('compares with the release before, as versions, not as text', () => {
    const gate = crashGate([fig('0.10.0', 90, 10), fig('0.9.0', 99, 1), fig('0.2.0', 50, 50)], '0.10.0')
    expect(gate.said).toContain('for 0.9.0')
  })
})

describe('a hotfix', () => {
  const base = { tags: ['v0.3.0', 'v0.3.1'], packageVersion: '0.3.2', fromAncestor: () => true, shops: ['0192f4a1'] }

  it('is the next patch, cut from the release it fixes, for named shops', () => {
    expect(hotfixProblems({ ...base, tag: 'v0.3.2' })).toEqual([])
  })

  it('is refused when it is not a patch, not cut from the release, or for nobody', () => {
    expect(hotfixProblems({ ...base, tag: 'v0.4.0', packageVersion: '0.4.0' })).toEqual([expect.stringMatching(/not a patch/)])
    expect(hotfixProblems({ ...base, tag: 'v0.3.2', fromAncestor: () => false })).toEqual(['this branch is not cut from v0.3.1'])
    expect(hotfixProblems({ ...base, tag: 'v0.3.2', shops: [] })).toEqual([expect.stringMatching(/name the shop/)])
    expect(hotfixProblems({ ...base, tag: 'v0.3.1', packageVersion: '0.3.1' })).toContain('v0.3.1 is already tagged')
  })

  it('carries its first shops in the tag, for the manifest', () => {
    expect(shopsFromTagMessage('hotfix v0.3.2\n\nshops: 0192f4a1, abcdef12')).toEqual({ only: ['0192f4a1', 'abcdef12'] })
    expect(shopsFromTagMessage('ShopOS 0.3.0')).toBeNull()
    expect(shopsFromTagMessage(undefined)).toBeNull()
  })
})
