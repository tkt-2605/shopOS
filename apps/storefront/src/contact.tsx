import type { Status } from './api'
import { waLink } from './money'

/*
 * How to reach the shop: where it is, when it is open, a call, directions and
 * WhatsApp -- each only when the shop has given it and has the switch on
 * (Settings, Online orders, on the till). Read from the status kept on the
 * phone, so it is there even while the shop cannot be reached, which is when
 * a customer most wants it.
 */

export const WHATSAPP_ICON = 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.5 13.9c-.2.6-1.3 1.2-1.8 1.3-.5 0-1 .2-3.3-.7-2.8-1.1-4.6-4-4.7-4.2-.1-.2-1.1-1.5-1.1-2.9s.7-2.1 1-2.4c.3-.3.6-.3.8-.3h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .6l-.4.6-.4.4c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.5.3.1.2.1.6-.1 1.1z'

export function whatsappChat(status: Status | null): string | null {
  return status?.whatsapp && status.offers?.whatsappChat ? status.whatsapp : null
}

export function whatsappCart(status: Status | null): string | null {
  return status?.whatsapp && status.offers?.whatsappCart ? status.whatsapp : null
}

export function ContactCard({ status, shopName, title = 'Contact the shop' }: { status: Status | null; shopName: string; title?: string }) {
  const about = status?.about
  const wa = whatsappChat(status)
  const has = about && (about.address || about.phone || about.email || about.hours)
  if (!has && !wa) return null
  return (
    <section className="contact-card">
      <h2 className="section">{title}</h2>
      <div className="card">
        <p className="who">{shopName}</p>
        {about?.address && <p>{about.address}</p>}
        {about?.hours && <p className="muted">Open {about.hours}</p>}
        {about?.email && <p className="muted">{about.email}</p>}
        <div className="contact-actions">
          {about?.phone && (
            <a className="contact-btn" href={`tel:${about.phone.replace(/[^\d+]/g, '')}`}>
              <svg viewBox="0 0 24 24" aria-hidden><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
              Call
            </a>
          )}
          {wa && (
            <a className="contact-btn wa" href={waLink(wa, `Hello ${shopName}, `)} target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24" aria-hidden className="fill"><path d={WHATSAPP_ICON} /></svg>
              WhatsApp
            </a>
          )}
          {about?.address && (
            <a className="contact-btn" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(about.address)}`} target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24" aria-hidden><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" /></svg>
              Directions
            </a>
          )}
        </div>
      </div>
    </section>
  )
}
