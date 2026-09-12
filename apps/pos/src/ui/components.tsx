import { useEffect, type ReactNode } from 'react'
import { Money } from '@shopos/core'

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

export function Field({
  label, hint, children,
}: { label: string; hint?: string | undefined; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

export function Modal({
  title, children, footer, onClose, wide = false,
}: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">{title}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Alert({ kind = 'bad', children }: { kind?: 'bad' | 'warn' | 'ok'; children: ReactNode }) {
  const cls = kind === 'bad' ? 'alert' : `alert ${kind}`
  return <div className={cls}>{children}</div>
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
