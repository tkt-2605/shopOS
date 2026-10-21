import {
  cloneElement, isValidElement, useEffect, useId, useRef,
  type ReactElement, type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Money, businessDate } from '@shopos/core'
import { pushModal, popModal, isTopModal } from '../core/modalStack'

/** What a screen is looking at. The same shape the report queries take. */
export interface Range {
  from: string
  to: string
}

export const RANGE_PRESETS = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  lastMonth: 'Last month',
  year: 'This year',
} as const

export type RangePreset = keyof typeof RANGE_PRESETS

/**
 * The window a screen is looking through.
 *
 * Lifted out of `Reports.tsx` when the bills screen wanted the same thing.
 * Three copies of a date range would be three places to get `businessDate()`
 * wrong — and getting it wrong means a shop in India asking for "today" at
 * half past nine in the evening and being shown tomorrow, because
 * `toISOString()` has already rolled over to UTC.
 */
export function rangePreset(which: RangePreset): Range {
  const now = new Date()
  switch (which) {
    case 'today':
      return { from: businessDate(now), to: businessDate(now) }
    case 'week': {
      const start = new Date(now)
      // Monday, because a shop's week and a spreadsheet's week should agree.
      start.setDate(now.getDate() - ((now.getDay() + 6) % 7))
      return { from: businessDate(start), to: businessDate(now) }
    }
    case 'month':
      return { from: businessDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: businessDate(now) }
    case 'lastMonth': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: businessDate(first), to: businessDate(last) }
    }
    case 'year':
      return { from: businessDate(new Date(now.getFullYear(), 0, 1)), to: businessDate(now) }
  }
}

export function sameRange(a: Range, b: Range): boolean {
  return a.from === b.from && a.to === b.to
}

export function DateRangePicker<T extends Range>({ value, onChange, presets }: {
  value: T
  onChange: (next: T) => void
  /** Which shortcuts to offer. All of them unless a screen says otherwise. */
  presets?: readonly RangePreset[]
}) {
  const offered = presets ?? (Object.keys(RANGE_PRESETS) as RangePreset[])

  return (
    <>
      <div className="segment">
        {offered.map((p) => (
          <button key={p} type="button" aria-pressed={sameRange(value, rangePreset(p))}
            onClick={() => onChange({ ...value, ...rangePreset(p) })}>
            {RANGE_PRESETS[p]}
          </button>
        ))}
      </div>

      <label className="range-field">
        From
        <input className="input num" type="date" value={value.from}
          onChange={(e) => onChange({ ...value, from: e.target.value })} />
      </label>
      <label className="range-field">
        to
        <input className="input num" type="date" value={value.to}
          onChange={(e) => onChange({ ...value, to: e.target.value })} />
      </label>
    </>
  )
}

export function Rupees({ value, className = '' }: { value: number; className?: string }) {
  return <span className={`num ${className}`}>{Money.formatWithSymbol(value as never)}</span>
}

export function Card({ title, actions, children }: { title?: string | undefined; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          <div className="spacer" />
          {actions}
        </div>
      )}
      <div className="card-body">{children}</div>
    </div>
  )
}

/** The controls a `<label for>` can point at. */
const LABELABLE = new Set(['input', 'select', 'textarea'])

export function Field({
  label, hint, aside, children,
}: {
  label: string; hint?: string | undefined
  /** Beside the label, at the right: a small switch that says how the box is read. */
  aside?: ReactNode
  children: ReactNode
}) {
  const made = useId()
  const hintId = `${made}-hint`

  /* The label is tied to its control, so a screen reader reads the one with the
     other and a click on the words puts the cursor in the box. A lone input,
     select or textarea is given an id if it has none; anything else -- a button
     standing in for a picker, several controls together -- is left as it is. */
  const control = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children)
    && typeof children.type === 'string' && LABELABLE.has(children.type)
    ? children as ReactElement<{ id?: string; 'aria-describedby'?: string }>
    : null
  const controlId: string = control?.props.id ?? made

  return (
    <div className="field">
      {aside
        ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <label htmlFor={control ? controlId : undefined}>{label}</label>
            {aside}
          </div>
        )
        : <label htmlFor={control ? controlId : undefined}>{label}</label>}
      {control
        ? cloneElement(control, {
            id: controlId,
            ...(hint ? { 'aria-describedby': hintId } : {}),
          })
        : children}
      {hint && <span className="hint" id={hintId}>{hint}</span>}
    </div>
  )
}

/** Everything a person can Tab to, in the order they would reach it. */
const TABBABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Whether a control is actually on screen.
 *
 * Walked up the tree rather than asked of `offsetParent`, which answers null for
 * a positioned element and would drop every control in a dialog the moment one
 * was given `position: fixed`.
 */
function isVisible(el: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView
  if (!view) return true
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.hidden) return false
    const style = view.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

function tabbablesIn(root: HTMLElement): HTMLElement[] {
  // A hidden control is still in the DOM and still matches the selector, and
  // tabbing to something nobody can see reads as the dialog having lost focus.
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(isVisible)
}

/**
 * A dialog that owns the keyboard while it is open.
 *
 * Four things, all of which used to be the caller's problem and were therefore
 * nobody's:
 *
 *   - **Tab stays inside.** It cycles the dialog's own controls and never walks
 *     off into the page behind, which the counter could see happening and not
 *     explain.
 *   - **Focus arrives and goes back.** The first field is focused on open; when
 *     the dialog closes, focus returns to whatever opened it, so the keyboard
 *     does not start again from the top of the page.
 *   - **Only the top one hears Escape.** Two dialogs stacked — a bill with its
 *     return sheet over it — used to close together.
 *   - **The page behind is inert**, handled by the stack, so a click that lands
 *     past the backdrop does nothing at all.
 *
 * It is portalled to the body so that "the page behind" is a single element the
 * stack can mark, rather than whichever branch of the tree happened to render it.
 */
export function Modal({
  title, children, footer, onClose, wide = false, initialFocus,
}: {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  wide?: boolean
  /** When the first field is the wrong place to land. */
  initialFocus?: RefObject<HTMLElement | null> | undefined
}) {
  const id = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    pushModal(id)

    // Landing: what was asked for, else the first thing that can be typed into,
    // else the dialog itself so the trap has something to hold.
    const target = initialFocus?.current
      ?? (dialog.current ? tabbablesIn(dialog.current)[0] : null)
      ?? dialog.current
    target?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopModal(id)) return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    // Capture, so a page shortcut bound to the window cannot see the key first.
    window.addEventListener('keydown', onKey, true)

    return () => {
      window.removeEventListener('keydown', onKey, true)
      popModal(id)
      if (opener && document.contains(opener)) opener.focus()
    }
    // Mount and unmount only: re-running this would steal focus mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialog.current) return
    const stops = tabbablesIn(dialog.current)
    if (stops.length === 0) { e.preventDefault(); return }

    const first = stops[0]!
    const last = stops[stops.length - 1]!
    const here = document.activeElement

    // Wrapping is the whole point: past the last control is the first one, not
    // the page behind.
    if (!e.shiftKey && here === last) { e.preventDefault(); first.focus(); return }
    if (e.shiftKey && here === first) { e.preventDefault(); last.focus(); return }
    if (!dialog.current.contains(here)) { e.preventDefault(); first.focus() }
  }

  return createPortal(
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={dialog}
        className={wide ? 'modal wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">{title}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Alert({ kind = 'bad', children }: { kind?: 'bad' | 'warn' | 'ok'; children: ReactNode }) {
  const cls = kind === 'bad' ? 'alert' : `alert ${kind}`
  // Announced, not only shown: an error interrupts, anything else waits its turn.
  return <div className={cls} role={kind === 'bad' ? 'alert' : 'status'}>{children}</div>
}

export function DocStatusBadge({ status }: { status: number }) {
  if (status === 1) return <span className="badge ok">Submitted</span>
  if (status === 2) return <span className="badge bad">Cancelled</span>
  return <span className="badge mute">Draft</span>
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}
