import { useState } from 'react'
import { deviceSetting, setDeviceSetting } from '../core/device'
import type { Side } from './gstPair'

/*
 * Which way a cost is typed: before GST or with it. One switch for the whole
 * column, in its header, rather than a second box on every line -- a shop
 * types costs one way off one bill, and two boxes side by side was one more
 * thing to read than anybody needed.
 *
 * Flipping it changes how every line is shown, never what it is: a cost typed
 * with GST and shown without it is still the cost that was typed (`gstPair.ts`
 * keeps the typed side and works out the other).
 *
 * Remembered on this machine, for Stock In, purchase orders and an item's own
 * cost price alike: the person at this desk gets the bills they get. An item's
 * selling rate has a switch of its own, starting with GST, which is how a shelf
 * price is said.
 */

/** Costs, from the supplier's bill. Before GST until somebody says otherwise. */
export const COST_ENTRY = { key: 'cost_entry_gst', start: 'before' } as const
/** An item's selling rate. With GST until somebody says otherwise. */
export const RATE_ENTRY = { key: 'rate_entry_gst', start: 'with' } as const

/** The switch's state, starting where this machine last left it. */
export function useGstMode(
  { key, start }: { key: string; start: Side } = COST_ENTRY,
): [Side, (side: Side) => void] {
  const [mode, setMode] = useState<Side>(() => {
    const kept = deviceSetting(key)
    return kept === 'with' || kept === 'before' ? kept : start
  })
  const choose = (side: Side) => {
    setMode(side)
    void setDeviceSetting(key, side === start ? null : side)
  }
  return [mode, choose]
}

export function GstSwitch({ mode, onChange, label = 'Costs are' }: {
  mode: Side; onChange: (side: Side) => void; label?: string
}) {
  return (
    <div className="segment segment-sm" role="group" aria-label={label}>
      <button type="button" aria-pressed={mode === 'before'} onClick={() => onChange('before')}>Excl. GST</button>
      <button type="button" aria-pressed={mode === 'with'} onClick={() => onChange('with')}>Incl. GST</button>
    </div>
  )
}
