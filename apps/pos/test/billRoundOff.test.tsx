import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { BillDetail } from '@shopos/core'

/**
 * The bill window says the round off, as the receipt does: without it a total
 * of ₹548 under ₹548.04 of taxable and GST is a figure nobody can explain.
 */

vi.mock('../src/ui/BillEmailLine', () => ({ BillEmailLine: () => null }))
vi.mock('../src/ui/Attachments', () => ({ Attachments: () => null }))
const { BillBody } = await import('../src/pages/bills/BillBody')

afterEach(cleanup)

const bill = (roundOff: number) => ({
  id: 'b1', docNo: 'BCR1/2627/00014', docstatus: 1, postingDate: '2026-10-22', customerName: null,
  cancelReason: null, items: [], payments: [{ method: 'cash', amount: 54804 + roundOff }],
  subtotal: 54804, discount: 0, taxableTotal: 54804, taxTotal: 0, roundOff, grandTotal: 54804 + roundOff,
}) as unknown as BillDetail

const show = (b: BillDetail) => render(
  <BillBody bill={b} returns={[]} canUnreturn={false} canAttach={false}
    onCreditNote={vi.fn()} onUndoReturn={vi.fn()} onAttachmentsChange={vi.fn()} />)

describe('the round off on a bill', () => {
  it('is its own line when the bill was rounded', () => {
    show(bill(-4))
    expect(screen.getByText('Round off')).toBeTruthy()
    expect(screen.getByText('₹-0.04')).toBeTruthy()
  })

  it('is not there when nothing was rounded', () => {
    show(bill(0))
    expect(screen.queryByText('Round off')).toBeNull()
  })
})
