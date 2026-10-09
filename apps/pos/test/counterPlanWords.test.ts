import { describe, it, expect } from 'vitest'
import { counterPlanNotice, type CounterPlanFacts } from '../src/core/counterPlanWords'

const base: CounterPlanFacts = {
  role: 'till', mayTakeMoney: true, state: 'active',
  paidThrough: '2026-12-31', graceUntil: '2027-02-11', today: '2026-10-10', mainName: 'Front counter',
}

describe('what an extra till says about the plan', () => {
  it('says nothing on the main, on a till alone, or while the plan is far from its end', () => {
    expect(counterPlanNotice({ ...base, role: 'main', mayTakeMoney: true })).toBeNull()
    expect(counterPlanNotice({ ...base, role: 'alone' })).toBeNull()
    expect(counterPlanNotice(base)).toBeNull()
  })

  it('warns in the week before the paid-through date, naming the main', () => {
    const said = counterPlanNotice({ ...base, today: '2026-12-26' })
    expect(said).toContain('2026-12-31')
    expect(said).toContain('Front counter')
  })

  it('says until when it can bill, through grace', () => {
    const said = counterPlanNotice({ ...base, state: 'grace', today: '2027-01-05' })
    expect(said).toContain('2027-02-11')
  })

  it('says where to bill instead once it is view-only', () => {
    const said = counterPlanNotice({ ...base, state: 'lapsed', mayTakeMoney: false })
    expect(said).toContain('view-only')
    expect(said).toContain('Front counter')
  })
})
