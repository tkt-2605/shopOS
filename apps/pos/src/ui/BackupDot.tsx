import { useCore } from '../core/CoreProvider'
import { goTo } from '../core/nav'

/**
 * A red mark in the top bar for as long as the last automatic backup failed.
 *
 * The failure it reports happens at startup or at 02:00, on a screen nobody is
 * looking at, and its only previous home was the Settings page — which is the
 * one screen a shop opens because something is already wrong. That ordering is
 * backwards: the point of saying a backup failed is to be seen on the morning
 * it failed, not on the afternoon the disk dies.
 *
 * It is a dot and a word rather than a banner or a dialog, because the rule is
 * that the counter is never interrupted. Clicking it goes to Settings, where
 * the Backup card has the message in full.
 */
export function BackupDot() {
  const { backup } = useCore()
  if (!backup?.error) return null

  return (
    <button
      className="link-btn"
      title={backup.error}
      onClick={() => goTo('settings')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        color: 'var(--danger)', fontSize: 12.5,
      }}
    >
      <span aria-hidden style={{
        width: 7, height: 7, background: 'var(--danger)', display: 'inline-block',
      }} />
      Backup failed
    </button>
  )
}
