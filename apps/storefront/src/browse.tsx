import { useMemo, useState } from 'react'
import type { CatalogItem } from './api'
import { Items } from './items'
import { ContactCard } from './contact'
import { brandsIn, groupAndBelow, NO_FILTERS, shelf, type Filters, type SortBy } from './shelf'
import type { Shop } from './useShop'

/* The shop: search, groups, grid or list. Everything here is worked out from
   the catalogue on the phone, with no request per keystroke. */

const SORTS: { id: SortBy; label: string }[] = [
  { id: 'best', label: 'Best match' },
  { id: 'low', label: 'Price: low to high' },
  { id: 'high', label: 'Price: high to low' },
  { id: 'saving', label: 'Biggest saving' },
  { id: 'name', label: 'Name' },
]

export function ShopPage({ shop, params, go, open }: {
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

  const first = shop.account?.name?.trim().split(/\s+/)[0]
  const head = (
    <p className="greet">{first ? <>Hi {first}, <span>what do you need today?</span></> : <span>What do you need today?</span>}</p>
  )

  if (!catalog) {
    return (
      <>
        {head}
        <p className="empty">{shop.state === 'checking' ? 'Loading the shop…' : 'The shop’s items have not loaded yet. They will once the shop can be reached.'}</p>
      </>
    )
  }

  const tops = catalog.categories.filter((c) => c.parentId === null || !catalog.categories.some((p) => p.id === c.parentId))
  const active = f.brands.size + Number(f.inStockOnly)
  const toGroup = (id: string | null) => go(id ? `/shop?g=${id}` : '/shop')

  return (
    <>
      {head}
      <div className="shop-top">
      <div className="search-row">
        <label className="search">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4" /></svg>
          <input type="search" placeholder="Search pens, notebooks, folders…" aria-label="Search"
            value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} />
        </label>
        <div className="layout-switch" role="group" aria-label="Layout">
          <button type="button" aria-pressed={shop.layout === 'grid'} aria-label="Grid" onClick={() => shop.setLayout('grid')}>
            <svg viewBox="0 0 24 24" aria-hidden><path d="M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z" /></svg>
          </button>
          <button type="button" aria-pressed={shop.layout === 'list'} aria-label="List" onClick={() => shop.setLayout('list')}>
            <svg viewBox="0 0 24 24" aria-hidden><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
        </div>
      </div>
      <div className="chips">
        <button type="button" aria-pressed={group === null && !f.offersOnly} onClick={() => { setF({ ...f, offersOnly: false }); toGroup(null) }}>All</button>
        <button type="button" aria-pressed={f.offersOnly} onClick={() => setF({ ...f, offersOnly: !f.offersOnly })}>Offers</button>
        {tops.map((c) => (
          <button key={c.id} type="button" aria-pressed={group === c.id} onClick={() => toGroup(c.id)}>{c.name}</button>
        ))}
      </div>
      </div>
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
          <label><input type="checkbox" checked={f.inStockOnly} onChange={(e) => setF({ ...f, inStockOnly: e.target.checked })} /> In stock only</label>
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
          {active > 0 && <button type="button" className="link-button" onClick={() => setF({ ...f, brands: new Set(), inStockOnly: false })}>Clear filters</button>}
        </div>
      )}
      <Items items={items} shop={shop} onOpen={open} layout={shop.layout} />
      {items.length === 0 && <p className="empty">Nothing matches. Try fewer words, or clear the filters.</p>}
      <ContactCard status={shop.status} shopName={catalog.shop || shop.status?.shop || 'TRT'} title="Visit or contact us" />
    </>
  )
}
