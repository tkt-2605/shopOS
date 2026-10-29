import { ContactCard } from './contact'
import { SignInPanel } from './cart'
import { PageHead } from './items'
import { startAfresh } from './keep'
import { useState } from 'react'
import type { Shop } from './useShop'

/* Who is signed in, how this phone shows the catalogue, and where the shop is. */

export function Account({ shop }: { shop: Shop }) {
  if (shop.session === null) {
    return (
      <>
        <SignInPanel shop={shop} />
        <Device shop={shop} />
        <ContactCard status={shop.status} shopName={shop.held?.catalog.shop || shop.status?.shop || 'TRT'} />
      </>
    )
  }
  const a = shop.account
  return (
    <>
      <PageHead title="Account" sub="Your shop profile" />
      {a === null ? (
        <div className="card">
          <p className="who">Signed in</p>
          <p className="muted">Your name and mobile show here once the shop can be reached.</p>
        </div>
      ) : (
      <div className="card">
        <p className="who">{a.name ?? 'No name yet'}</p>
        <p className="muted">{a.phone ?? 'No mobile number yet'}</p>
        {a.email && <p className="muted">{a.email}</p>}
        {a.phone && (
          <p className="muted">{a.phoneVerified ? 'Mobile confirmed by the shop' : 'The shop confirms your mobile number at your first pickup'}</p>
        )}
      </div>
      )}
      <Device shop={shop} />
      <ContactCard status={shop.status} shopName={shop.held?.catalog.shop || shop.status?.shop || 'TRT'} />
      <button type="button" className="ghost wide" onClick={() => void shop.signOut()}>Sign out</button>
    </>
  )
}

function Device({ shop }: { shop: Shop }) {
  const [busy, setBusy] = useState(false)
  return (
    <>
      <h2 className="section">This device</h2>
      <div className="card setting">
        <div>
          <strong>Catalog layout</strong>
          <p className="muted">List is text-only for speed. Open an item to see its photo.</p>
        </div>
        <div className="toggle" role="group" aria-label="Catalog layout">
          <button type="button" aria-pressed={shop.layout === 'grid'} onClick={() => shop.setLayout('grid')}>Grid</button>
          <button type="button" aria-pressed={shop.layout === 'list'} onClick={() => shop.setLayout('list')}>List</button>
        </div>
      </div>
      <div className="card setting">
        <div>
          <strong>Refresh saved copy</strong>
          <p className="muted">Fetches the items, prices and photos fresh from the shop. Your cart stays.</p>
        </div>
        <button type="button" className="ghost" disabled={busy || shop.state !== 'open' && shop.state !== 'closed'}
          onClick={() => { setBusy(true); void startAfresh() }}>{busy ? 'Refreshing…' : 'Refresh'}</button>
      </div>
    </>
  )
}
