import { describe, it, expect } from 'vitest'
import { submitMessage } from '../src/pages/billing/submitMessage'

/* What the cashier reads when credit is refused (082: zero is no credit). */
describe('a credit sale refused', () => {
  it('says the customer is not given credit when their limit is zero', () => {
    const text = submitMessage({ ok: false, code: 'CREDIT_LIMIT_EXCEEDED', limit: 0 as never, projected: 58000 as never, excess: 58000 as never })
    expect(text).toMatch(/not given credit/)
    expect(text).not.toMatch(/Over the credit limit/)
  })

  it('says by how much when there is a limit', () => {
    const text = submitMessage({ ok: false, code: 'CREDIT_LIMIT_EXCEEDED', limit: 50000 as never, projected: 60000 as never, excess: 10000 as never })
    expect(text).toMatch(/Over the credit limit by ₹100/)
  })
})
