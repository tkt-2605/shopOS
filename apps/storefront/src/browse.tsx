import { useMemo, useState } from 'react'
import { imageUrl, type Catalog, type CatalogItem } from './api'
import { Grid, Row, savedNote } from './items'
import { againFrom, brandsIn, groupAndBelow, NO_FILTERS, onOffer, saving, firstUnit, shelf, type Filters, type SortBy } from './shelf'
import { addToCart } from './money'
import type { Shop } from './useShop'

/* The home page and the shop's full list. Everything here is worked out from
   the catalogue on the phone. */

export function Home({ shop, go, open }: { shop: Shop; go: (to: string) => void; open: (i: CatalogItem) => void }) {
  const catalog = shop.held?.catalog
  if (!catalog) return <Loading shop={shop} />
  const note = savedNote(shop.state, shop.held?.since)
  const byId = new Map(catalog.items.map((i) => [i.id, i]))
  const offers = catalog.items.filter(onOffer)
    .sort((a, b) => (saving(firstUnit(b))?.percent ?? 0) - (saving(firstUnit(a))?.percent ?? 0)).slice(0, 12)
  const viewed = shop.viewed.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
  const last = shop.orders?.orders.find((o) => o.lines.length > 0)
  const about = shop.status?.about

  return (
    <>
      {note && <p className="saved">{note}</p>}
      <section className="hero">
        <h1>Everything for school and office, ready when you are.</h1>
        <p>Order from {catalog.shop || 'the shop'} online, pick up at the counter, pay when you collect.</p>
        <button type="button" className="search-fake" onClick={() => go('/shop')}>Search {catalog.items.length} items…</button>
      </section>

      <Groups catalog={catalog} go={go} />
      <Row title="Offers" items={offers} shop={shop} onOpen={open} more={() => go('/shop?offers=1&sort=saving')} />
      {last && (
        <section className="again">
          <div>
            <strong>Order again</strong>
            <span className="muted"> · {last.lines.length} item{last.lines.length === 1 ? '' : 's'} from your last order</span>
          </div>
          <button type="button" className="primary" onClick={() => {
            let cart = shop.cart
            for (const l of againFrom(last.lines, catalog)) cart = addToCart(cart, l)
            shop.setCart(cart)
            go('/cart')
          }}>Add to cart</button>
        </section>
      )}
      <Row title="Recently viewed" items={viewed} shop={shop} onOpen={open} />
      <Row title="All items" items={catalog.items.slice(0, 12)} shop={shop} onOpen={open} more={() => go('/shop')} />
      {about && (about.address || about.phone || about.hours) && (
        <section className="about">
          <h2>Visit us</h2>
          {about.address && <p>{about.address}</p>}
          {about.hours && <p className="muted">{about.hours}</p>}
          <p className="about-links">
            {about.phone && <a href={`tel:${about.phone.replace(/[^\d+]/g, '')}`}>Call {about.phone}</a>}
            {about.address && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(about.address)}`} target="_blank" rel="noreferrer">Directions</a>}
          </p>
        </section>
      )}
    </>
  )
}

function Groups({ catalog, go }: { catalog: Catalog; go: (to: string) => void }) {
  const tops = catalog.categories.filter((c) => c.parentId === null || !catalog.categories.some((p) => p.id === c.parentId))
  if (tops.length < 2) return null
  return (
    <section className="groups">
      {tops.map((g) => {
        const ids = groupAndBelow(catalog, g.id)
        const inIt = catalog.items.filter((i) => i.categoryId !== null && ids.has(i.categoryId))
        const pic = inIt.find((i) => i.thumb)?.thumb
        return (
          <button key={g.id} type="button" className="group" onClick={() => go(`/shop?g=${g.id}`)}>
            {pic ? <img src={imageUrl(pic)} alt="" loading="lazy" /> : <span className="noimg">{g.name.slice(0, 1)}</span>}
            <span className="name">{g.name}</span>
            <span className="muted">{inIt.length} items</span>
          </button>
        )
      })}
    </section>
  )
}

const SORTS: { id: SortBy; label: string }[] = [
  { id: 'best', label: 'Best match' },
  { id: 'low', label: 'Price: low to high' },
  { id: 'high', label: 'Price: high to low' },
  { id: 'saving', label: 'Biggest saving' },
  { id: 'name', label: 'Name' },
]

export function ShopList({ shop, params, go, open }: {
  shop: Shop; params: URLSearchParams; go: (to: string) => void; open: (i: CatalogItem) => void
}) {
  const catalog = shop.held?.catalog
  const group = params.get('g')
  const [f, setF] = useState<Filters>(() => ({
    ...NO_FILTERS,
    query: params.get('q') ?? '',
    offersOnly: params.get('offers') === '1',
    sort: (params.get('sort') as SortBy | null) ?? 'best',
  }))
  const [showFilters, setShowFilters] = useState(false)

  const scoped = useMemo(() => (catalog && group ? groupAndBelow(catalog, group) : null), [catalog, group])
  const items = useMemo(() => (catalog ? shelf(catalog, { ...f, groupIds: scoped }) : []), [catalog, f, scoped])
  const brands = useMemo(() => (catalog ? brandsIn(shelf(catalog, { ...NO_FILTERS, groupIds: scoped })) : []), [catalog, scoped])

  if (!catalog) return <Loading shop={shop} />
  const note = savedNote(shop.state, shop.held?.since)
  const tops = catalog.categories.filter((c) => c.parentId === null || !catalog.categories.some((p) => p.id === c.parentId))
  const active = f.brands.size + Number(f.offersOnly) + Number(f.inStockOnly)

  return (
    <>
      {note && <p className="saved">{note}</p>}
      <input className="search" type="search" autoFocus={!group} placeholder="Search items, brands…"
        value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} />
      {tops.length > 1 && (
        <div className="chips">
          <button type="button" aria-pressed={group === null} onClick={() => go('/shop')}>All</button>
          {tops.map((c) => (
            <button key={c.id} type="button" aria-pressed={group === c.id} onClick={() => go(`/shop?g=${c.id}`)}>{c.name}</button>
          ))}
        </div>
      )}
      <div className="toolbar">
        <select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value as SortBy })} aria-label="Sort">
          {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button type="button" aria-pressed={showFilters} onClick={() => setShowFilters(!showFilters)}>
          Filters{active > 0 ? ` (${active})` : ''}
        </button>
        <span className="muted">{items.length} item{items.length === 1 ? '' : 's'}</span>
      </div>
      {showFilters && (
        <div className="filters">
          <label><input type="checkbox" checked={f.offersOnly} onChange={(e) => setF({ ...f, offersOnly: e.target.checked })} /> On offer</label>
          <label><input type="checkbox" checked={f.inStockOnly} onChange={(e) => setF({ ...f, inStockOnly: e.target.checked })} /> In stock</label>
          {brands.length > 0 && <div className="filter-title">Brand</div>}
          <div className="chips wrap">
            {brands.map((b) => (
              <button key={b} type="button" aria-pressed={f.brands.has(b)} onClick={() => {
                const next = new Set(f.brands)
                if (next.has(b)) next.delete(b)
                else next.add(b)
                setF({ ...f, brands: next })
              }}>{b}</button>
            ))}
          </div>
          {active > 0 && <button type="button" className="link-button" onClick={() => setF({ ...f, brands: new Set(), offersOnly: false, inStockOnly: false })}>Clear filters</button>}
        </div>
      )}
      <Grid items={items} shop={shop} onOpen={open} />
      {items.length === 0 && <p className="empty">Nothing matches. Try fewer words, or clear the filters.</p>}
    </>
  )
}

function Loading({ shop }: { shop: Shop }) {
  return <p className="empty">{shop.state === 'checking' ? 'Loading the shop…' : 'The shop’s items have not loaded yet. They will once the shop can be reached.'}</p>
}
