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
 * Remembered on this machine, for Stock In and purchase orders alike: the
 * person at this desk gets the bills they get.
 */

const KEY = 'cost_entry_gst'

/** The switch's state, starting where this machine last left it. */
export function useGstMode(): [Side, (side: Side) => void] {
  const [mode, setMode] = useState<Side>(() => (deviceSetting(KEY) === 'with' ? 'with' : 'before'))
  const choose = (side: Side) => {
    setMode(side)
    void setDeviceSetting(KEY, side === 'with' ? 'with' : null)
  }
  return [mode, choose]
}

export function GstSwitch({ mode, onChange }: { mode: Side; onChange: (side: Side) => void }) {
  return (
    <div className="segment segment-sm" role="group" aria-label="Costs are">
      <button type="button" aria-pressed={mode === 'before'} onClick={() => onChange('before')}>Excl. GST</button>
      <button type="button" aria-pressed={mode === 'with'} onClick={() => onChange('with')}>Incl. GST</button>
    </div>
  )
}
