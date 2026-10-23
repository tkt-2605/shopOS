import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  listPriceLists, updatePriceList, archivePriceList, restorePriceList, defaultPriceListId,
  listItemPrices, setLadder, listUnits, customersOnList, setCustomerPriceList, searchCustomers, searchProducts,
  productsByIds, Ladder, Quantity,
  type PriceList, type ItemPrice, type SaleUnit, type ProductListItem, type CustomerListItem,
} from '@shopos/core'
import { useCore, useDb, useUser } from '../../core/CoreProvider'
import { useShopChanged } from '../../core/useShopChanged'
import { Card, Field, Empty, Alert, Rupees } from '../../ui/components'
import { useConfirm } from '../../ui/useConfirm'
import { belowCostMessage, retryBelowCost } from '../../ui/belowCost'
import { LadderEditor, describeRowsProblem, type LadderRow } from '../../ui/LadderEditor'
import { usePickList, Results } from '../../ui/PickList'
import { useSearch } from '../../ui/useSearch'
import { NewList } from './NewList'

/*
 * The first tab: one price list at a time -- who buys on it, and every item it
 * prices -- with items added and changed in place.
 *
 * The shop's own list is not offered here. It holds each item's quantity
 * breaks above its selling rate, which belong to the item and are set on it.
 */

interface Editing {
  product: ProductListItem
  units: SaleUnit[]
  saleUnit: string
  rows: LadderRow[]
  from: string
  to: string
}

interface Row {
  key: string
  productId: string
  name: string
  saleUnit: string
  rungs: ItemPrice[]
}

export function ListPrices({ canWrite }: { canWrite: boolean }) {
  const db = useDb()
  const user = useUser()
  const breaks = useCore().features.tieredPricing
  const [confirmUi, ask] = useConfirm()
  const [lists, setLists] = useState<PriceList[]>([])
  const [showRemoved, setShowRemoved] = useState(false)
  const [chosenId, setChosenId] = useState('')
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [products, setProducts] = useState<Map<string, ProductListItem>>(new Map())
  const [people, setPeople] = useState<{ id: string; name: string }[]>([])
  const [editing, setEditing] = useState<Editing | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [look, setLook] = useState('')

  const loadLists = useCallback(async () => {
    const everyone = await defaultPriceListId(db)
    const all = (await listPriceLists(db, { includeArchived: showRemoved })).filter((l) => l.id !== everyone)
    setLists(all)
    setChosenId((now) => (all.some((l) => l.id === now) ? now : all.find((l) => !l.archived)?.id ?? ''))
  }, [db, showRemoved])

  const loadList = useCallback(async () => {
    if (!chosenId) { setPrices([]); setPeople([]); return }
    const rows = await listItemPrices(db, { priceListId: chosenId })
    setPrices(rows)
    setPeople(await customersOnList(db, chosenId))
    setProducts(new Map((await productsByIds(db, [...new Set(rows.map((r) => r.productId))])).map((p) => [p.id, p])))
  }, [db, chosenId])

  useEffect(() => { void loadLists() }, [loadLists])
  useEffect(() => { void loadList() }, [loadList])
  useShopChanged(async () => { await loadLists(); await loadList() })

  const list = lists.find((l) => l.id === chosenId) ?? null

  /** The rungs gathered under their item and unit: one line per thing priced. */
  const rows = useMemo(() => {
    const groups = new Map<string, Row>()
    for (const p of prices) {
      const key = `${p.productId}|${p.saleUnit}`
      const g = groups.get(key) ?? { key, productId: p.productId, name: p.productName, saleUnit: p.saleUnit, rungs: [] }
      g.rungs.push(p)
      groups.set(key, g)
    }
    const needle = look.trim().toLowerCase()
    return [...groups.values()]
      .filter((g) => needle === '' || g.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [prices, look])

  async function open(product: ProductListItem, saleUnit = product.baseUnit) {
    const existing = prices.filter((p) => p.productId === product.id && p.saleUnit === saleUnit)
    setEditing({
      product, units: await listUnits(db, product.id), saleUnit,
      rows: Ladder.rungsToRows(existing.map((p) => ({ minQty: p.minQty, rate: p.rate }))),
      from: existing[0]?.validFrom ?? '', to: existing[0]?.validTo ?? '',
    })
    setError(null)
  }

  async function save() {
    if (!editing || !list) return
    const parsed = Ladder.rowsToRungs(editing.rows)
    if (!parsed.ok) { setError(describeRowsProblem(parsed, editing.saleUnit) ?? 'The prices need checking.'); return }
    const write = (allowBelowCost: boolean) => setLadder(db, { actorId: user.id }, {
      productId: editing.product.id, priceListId: list.id, saleUnit: editing.saleUnit, rungs: parsed.rungs,
      validFrom: editing.from || null, validTo: editing.to || null,
      ...(allowBelowCost ? { allowBelowCost } : {}),
    })
    const result = await retryBelowCost(write, ask, setError)
    if (result === null) return
    if (!result.ok) {
      setError(result.code === 'BELOW_COST' ? belowCostMessage(result)
        : result.code === 'BAD_DATES' ? 'The last day is before the first.'
        : `This item does not sell in ${editing.saleUnit}. Add the unit on Inventory first.`)
      return
    }
    setEditing(null)
    setError(null)
    await loadList()
  }

  async function remove(row: Row) {
    if (!list) return
    if (!(await ask(`Take ${row.name} off ${list.name}?\n\nCustomers on this list will pay its normal price.`))) return
    await setLadder(db, { actorId: user.id }, { productId: row.productId, priceListId: list.id, saleUnit: row.saleUnit, rungs: [] })
    await loadList()
  }

  /** Every rate on the list read the other way from the next bill, so asked first. */
  async function flipTax() {
    if (!list) return
    const next = !list.ratesIncludeTax
    if (!(await ask(next
      ? `Read the prices on ${list.name} as including GST?\n\nFrom the next bill, 100 is 100 with the GST in it.`
      : `Read the prices on ${list.name} as before GST?\n\nFrom the next bill, 100 is 100 plus GST.`))) return
    await updatePriceList(db, { actorId: user.id }, { priceListId: list.id, ratesIncludeTax: next })
    await loadLists()
  }

  async function removeList() {
    if (!list) return
    if (list.archived) { await restorePriceList(db, { actorId: user.id }, list.id); await loadLists(); return }
    if (!(await ask(`Remove ${list.name}?\n\nIts prices are kept, and old bills priced from it can still be explained. You can bring it back with “Show removed lists”.`))) return
    const result = await archivePriceList(db, { actorId: user.id }, list.id)
    if (!result.ok) {
      setError(result.code === 'IS_DEFAULT'
        ? 'This list cannot be removed.'
        : `${result.customerCount === 1 ? 'One customer buys' : `${result.customerCount} customers buy`} on ${list.name}. `
          + 'Take them off it first, above, so nobody’s prices change without anyone deciding to.')
      return
    }
    await loadLists()
  }

  async function addPerson(c: CustomerListItem) {
    if (!list) return
    await setCustomerPriceList(db, { actorId: user.id }, c.id, list.id)
    await loadList()
  }

  async function dropPerson(p: { id: string; name: string }) {
    if (!list) return
    if (!(await ask(`Take ${p.name} off ${list.name}?\n\nThey will pay normal prices, and keep any prices of their own.`))) return
    await setCustomerPriceList(db, { actorId: user.id }, p.id, null)
    await loadList()
  }

  const normalOf = (row: Row) => {
    const p = products.get(row.productId)
    return p && p.baseUnit === row.saleUnit ? <Rupees value={p.baseRate} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>
  }

  return (
    <>
      {confirmUi}
      <Card title="Which price list">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {lists.length > 0 && (
            <select className="input" style={{ maxWidth: 280 }} value={chosenId} aria-label="Price list"
              onChange={(e) => { setChosenId(e.target.value); setEditing(null); setError(null) }}>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}{l.archived ? ' (removed)' : ''}</option>)}
            </select>
          )}
          {canWrite && <button className="btn" onClick={() => setCreating(true)}>New list</button>}
          <label style={{ fontSize: 12.5, color: 'var(--ink-2)', display: 'flex', gap: 5, alignItems: 'center' }}>
            <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
            Show removed lists
          </label>
        </div>
        {lists.length === 0 && !creating && (
          <div style={{ marginTop: 10 }}>
            <Empty>
              No price lists yet. A price list is a set of prices for a group of customers: Wholesale, School, Staff.
            </Empty>
          </div>
        )}
        {creating && (
          <NewList onClose={() => setCreating(false)} onMade={async (id) => {
            setCreating(false); await loadLists(); setChosenId(id)
          }} />
        )}
      </Card>

      {list && (
        <Card title={list.name}>
          {error && <div style={{ marginBottom: 11 }}><Alert>{error}</Alert></div>}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, marginBottom: 12 }}>
            <span>Prices on this list are</span>
            {canWrite && !list.archived ? (
              <button className="btn sm" onClick={() => void flipTax()} title="Change how this list's prices are read">
                {list.ratesIncludeTax ? 'with GST' : 'before GST, GST added at the counter'}
              </button>
            ) : <strong>{list.ratesIncludeTax ? 'with GST' : 'before GST'}</strong>}
            <span style={{ flex: 1 }} />
            {canWrite && (
              <button className="btn ghost sm" onClick={() => void removeList()}>
                {list.archived ? 'Bring this list back' : 'Remove this list'}
              </button>
            )}
          </div>

          <People people={people} canWrite={canWrite && !list.archived} onAdd={addPerson} onDrop={dropPerson} />

          {rows.length > 8 && (
            <input className="input" style={{ maxWidth: 320, margin: '12px 0 8px' }} placeholder="Find an item on this list"
              value={look} onChange={(e) => setLook(e.target.value)} aria-label="Find an item on this list" />
          )}

          <table style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Item</th><th className="r">Normal price</th><th className="r">On this list</th>
                {breaks && <th>Cheaper by quantity</th>}
                <th>Dates</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const [first, ...more] = row.rungs
                const product = products.get(row.productId)
                return (
                  <tr key={row.key}>
                    <td>
                      {row.name}
                      {product && product.baseUnit !== row.saleUnit && <div className="src">per {row.saleUnit}</div>}
                    </td>
                    <td className="r">{normalOf(row)}</td>
                    <td className="r">{first && <Rupees value={first.rate} />}</td>
                    {breaks && (
                      <td className="num" style={{ fontSize: 12 }}>
                        {more.map((r) => `${Quantity.formatQty(r.minQty)}+ ₹${(r.rate / 100).toFixed(2)}`).join(' · ')}
                      </td>
                    )}
                    <td style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                      {first?.validFrom || first?.validTo ? `${first.validFrom ?? '…'} to ${first.validTo ?? '…'}` : 'always'}
                    </td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      {canWrite && product && (
                        <button className="btn ghost sm" onClick={() => void open(product, row.saleUnit)}>Change</button>
                      )}
                      {canWrite && <button className="btn ghost sm" onClick={() => void remove(row)}>Remove</button>}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr><td colSpan={breaks ? 6 : 5}>
                  <Empty>{look ? 'Nothing on this list matches.' : 'No items on this list yet. Customers on it pay normal prices.'}</Empty>
                </td></tr>
              )}
            </tbody>
          </table>

          {canWrite && !list.archived && !editing && <AddItem onPick={(p) => void open(p)} />}

          {editing && (
            <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{editing.product.name} on {list.name}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 10 }}>
                Normal price <Rupees value={editing.product.baseRate} /> per {editing.product.baseUnit}.
                {breaks && ' The first row is the price on this list; add rows for cheaper by the quantity.'}
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <Field label="Unit">
                  <select className="input" value={editing.saleUnit}
                    onChange={(e) => setEditing({ ...editing, saleUnit: e.target.value })}>
                    <option value={editing.product.baseUnit}>{editing.product.baseUnit}</option>
                    {editing.units.map((u) => <option key={u.saleUnit} value={u.saleUnit}>{u.saleUnit}</option>)}
                  </select>
                </Field>
                <Field label="Price on this list">
                  <div style={{ minWidth: 300 }}>
                    <LadderEditor rows={editing.rows} unit={editing.saleUnit} breaks={breaks}
                      onChange={(r) => setEditing({ ...editing, rows: r })} />
                  </div>
                </Field>
                <Field label="From" hint="Blank: from today.">
                  <input className="input" type="date" value={editing.from}
                    onChange={(e) => setEditing({ ...editing, from: e.target.value })} />
                </Field>
                <Field label="Until" hint="Blank: no end.">
                  <input className="input" type="date" value={editing.to}
                    onChange={(e) => setEditing({ ...editing, to: e.target.value })} />
                </Field>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={() => void save()}>Save</button>
                <button className="btn ghost" onClick={() => { setEditing(null); setError(null) }}>Cancel</button>
              </div>
            </div>
          )}
        </Card>
      )}
    </>
  )
}

/** Who buys on the list, and a search to put somebody on it. */
function People({ people, canWrite, onAdd, onDrop }: {
  people: { id: string; name: string }[]
  canWrite: boolean
  onAdd: (c: CustomerListItem) => void | Promise<void>
  onDrop: (p: { id: string; name: string }) => void | Promise<void>
}) {
  const db = useDb()
  const [term, setTerm] = useState('')
  const box = useRef<HTMLInputElement>(null)
  const search = useSearch(term, (t) => searchCustomers(db, t, 15))
  const pick = usePickList({
    count: search.rows.length, resetKey: term,
    onPick: (i) => { const hit = search.rows[i]; if (hit) { setTerm(''); void onAdd(hit) } },
    enter: async () => { const [hit] = await search.latest(); if (hit) { setTerm(''); await onAdd(hit) } },
  })
  return (
    <div>
      <div style={{ fontSize: 12.5, marginBottom: 6 }}>
        <strong>Customers on this list</strong>
        <span style={{ color: 'var(--ink-3)' }}> pay these prices for the items below, and normal prices for the rest.</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {people.map((p) => (
          <span key={p.id} className="badge" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {p.name}
            {canWrite && (
              <button className="link-btn" aria-label={`Take ${p.name} off this list`} onClick={() => void onDrop(p)}>✕</button>
            )}
          </span>
        ))}
        {people.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Nobody yet.</span>}
        {canWrite && (
          <>
            <input className="input" ref={box} style={{ maxWidth: 240 }} placeholder="Add a customer"
              value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={pick.searchKeyDown} />
            <Results anchor={box} open={search.rows.length > 0}>
              <div {...pick.listProps}>
                {search.rows.map((c, i) => (
                  <div key={c.id} style={{ padding: '7px 10px' }} {...pick.rowProps(i)}>
                    {c.name}<span style={{ float: 'right', color: 'var(--ink-3)' }}>{c.phone ?? ''}</span>
                  </div>
                ))}
              </div>
            </Results>
          </>
        )}
      </div>
    </div>
  )
}

/** A search under the table that opens an item's price on this list. */
function AddItem({ onPick }: { onPick: (p: ProductListItem) => void }) {
  const db = useDb()
  const [term, setTerm] = useState('')
  const box = useRef<HTMLInputElement>(null)
  const search = useSearch(term, (t) => searchProducts(db, { term: t, limit: 15 }))
  const choose = (p: ProductListItem) => { setTerm(''); onPick(p) }
  const pick = usePickList({
    count: search.rows.length, resetKey: term,
    onPick: (i) => { const hit = search.rows[i]; if (hit) choose(hit) },
    enter: async () => { const [hit] = await search.latest(); if (hit) choose(hit) },
  })
  return (
    <div style={{ marginTop: 12, maxWidth: 420 }}>
      <input className="input" ref={box} placeholder="Add an item to this list — search by name or barcode"
        value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={pick.searchKeyDown} />
      <Results anchor={box} open={search.rows.length > 0}>
        <div {...pick.listProps}>
          {search.rows.map((p, i) => (
            <div key={p.id} style={{ padding: '7px 10px' }} {...pick.rowProps(i)}>
              {p.name}
              <span style={{ float: 'right', color: 'var(--ink-3)' }}>normal <Rupees value={p.baseRate} /></span>
            </div>
          ))}
        </div>
      </Results>
    </div>
  )
}
