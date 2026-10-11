import { describe, it, expect, vi } from 'vitest'
import type { SqlDriver } from '@shopos/core'

/**
 * The app's half of the health report: what it found, reduced to what may
 * leave the shop every day without anybody pressing anything.
 */

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../src/core/log', () => ({ logEvent: vi.fn(), describe: String }))
vi.mock('@shopos/core', async (original) => ({
  ...(await original<typeof import('@shopos/core')>()),
  getSetting: vi.fn(async () => '01a1256f-3b1b-4f79-b255-4d86f4a64e3c'),
  entitlement: vi.fn(async () => ({
    grants: [{ tier: 'business', state: 'active', paidThrough: null, graceUntil: null, tills: 3,
      shopId: '01a1256f', raw: 'LICENCE-CODE-SHOULD-NOT-APPEAR' }],
    tier: 'business', state: 'active', paidThrough: null, graceUntil: null, tills: 3,
    clockUnreliable: false, shopId: '01a1256f', problem: null,
  })),
  findDiscrepancies: vi.fn(async () => [{
    key: 'k1', kind: 'over_credit_limit', area: 'money',
    title: 'CUSTOMER-NAME-SHOULD-NOT-APPEAR is over their limit',
    detail: 'CUSTOMER-NAME-SHOULD-NOT-APPEAR owes ₹12,000', action: 'Call them',
    amount: 1200000, refs: ['BMR/2627/00012'], at: '2026-10-12',
  }]),
}))

const { appHealth, healthLine } = await import('../src/core/health')

describe('the app half of the health report', () => {
  it('carries the licence state and the kind of each problem, never a name, an amount or a code', async () => {
    const app = await appHealth({} as SqlDriver)
    const text = JSON.stringify(app)
    expect(text).not.toContain('CUSTOMER-NAME-SHOULD-NOT-APPEAR')
    expect(text).not.toContain('LICENCE-CODE-SHOULD-NOT-APPEAR')
    expect(text).not.toContain('1200000')
    expect(text).toContain('over_credit_limit')
    expect(text).toContain('BMR/2627/00012')
    expect(app['licence']).toMatchObject({ tier: 'business', state: 'active', problem: null })
  })

  it('puts what matters first in one line', () => {
    expect(healthLine({
      licence: { state: 'active', problem: 'BAD_SIGNATURE' },
      discrepancies: [{}, {}],
      lastSyncRound: { reports: [
        { peer: 'till-2', ok: false, received: 0, sent: 0, contested: 0, quarantined: 0, error: 'connection timed out' },
        { peer: 'till-3', ok: true, received: 3, sent: 1, contested: 0, quarantined: 1 },
      ] },
    })).toBe('licence: BAD_SIGNATURE | 2 problem(s) flagged | sync failing: connection timed out | 1 record(s) set aside')
    expect(healthLine({ licence: { state: 'none', problem: null }, discrepancies: [], lastSyncRound: null }))
      .toBe('licence: none | no problems flagged')
  })
})
