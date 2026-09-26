import { useId, type ReactNode } from 'react'

/**
 * The pieces every Settings section is built from.
 *
 * Kept apart from the sections so that a section is only what it says -- which
 * settings, in which words -- and the way a switch or a choice is drawn is
 * decided once.
 */

/** The sentence under a section's title, saying what the section is for. */
export function Intro({ children }: { children: ReactNode }) {
  return <p className="settings-intro">{children}</p>
}

/** A titled group inside a card, with the reason for it under the title. */
export function Group({ title, why, children }: { title: string; why?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-group">
      <div className="settings-group-title">{title}</div>
      {why && <div className="settings-group-why">{why}</div>}
      {children}
    </div>
  )
}

/**
 * A switch with its consequence written beside it.
 *
 * The note is not decoration. Every one of these changes what other screens do,
 * and an owner flicking it deserves to know what happens to the data they have
 * already entered before they find out by looking for it.
 */
export function Switch({
  id, on, onChange, title, note,
}: {
  id: string
  on: boolean
  onChange: (on: boolean) => void
  title: string
  note: string
}) {
  return (
    <label htmlFor={id} className="settings-switch">
      <input type="checkbox" id={id} checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="settings-option-title">{title}</span>
        <span className="settings-option-note">{note}</span>
      </span>
    </label>
  )
}

/**
 * One answer out of several, where a switch would be a lie.
 *
 * Laid out as full rows rather than a dropdown because each option needs its
 * consequence written beside it -- these change what happens at a counter.
 *
 * Each group has a name of its own. They all shared "stock-policy" once, which
 * made the GST scheme, the stock rule and the rounding rule one radio group to
 * the browser: arrowing down off the last GST option changed the stock policy.
 */
export function Choice<T extends string>({
  value, onChange, options, label,
}: {
  value: T
  onChange: (next: T) => void
  options: { id: T; title: string; note: string }[]
  label: string
}) {
  const name = useId()
  return (
    <div role="radiogroup" aria-label={label} className="settings-choice">
      {options.map((o) => (
        <label key={o.id} className="settings-choice-row" data-on={value === o.id}>
          <input type="radio" name={name} checked={value === o.id} onChange={() => onChange(o.id)} />
          <span>
            <span className="settings-option-title">{o.title}</span>
            <span className="settings-option-note">{o.note}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

/** "at 02:00 today", "yesterday", or the date -- enough to place it, no more. */
export function whenWas(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'at an unknown time'
  const day = new Date(at); day.setHours(0, 0, 0, 0)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (days === 0) return `at ${time} today`
  if (days === 1) return `at ${time} yesterday`
  return `on ${at.toLocaleDateString()} at ${time}`
}
