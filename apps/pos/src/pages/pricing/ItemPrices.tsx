import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  listPriceLists, listItemPrices, setItemPrice, removeItemPrice, listUnits, perBaseUnit,
  searchProducts, productsByIds, Money, Quantity, type PriceList, type ItemPrice, type SaleUnit,
  type ProductListItem,
} from '@shopos/core'
import { useCore, useDb, useUser } from '../../core/CoreProvider'
import { Card, Field, Empty, Alert, Rupees } from '../../ui/components'
import { usePickList, Results } from '../../ui/PickList'

/* The first tab: pick an item, and say what it costs on each list and from what quantity. */

export function ItemPrices({ canWrite }: { canWrite: boolean }) {
  const db = useDb()
  const breaks = useCore().features.tieredPricing
  const user = useUser()
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<ProductListItem[]>([])
  const [chosen, setChosen] = useState<ProductListItem | null>(null)
  const [units, setUnits] = useState<SaleUnit[]>([])
  const [lists, setLists] = useState<PriceList[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [error, setError] = useState<string | null>(null)
  /**
   * Every rate in the shop, so the tab answers "what have we set" without
   * being told which item to look at first. Before this, the only way to find
   * out whether anything had a special rate was to search items one at a time.
   */
  const [everyone, setEveryone] = useState<ItemPrice[]>([])
  const [look, setLook] = useState('')

  const [row, setRow] = useState({ priceListId: '', saleUnit: '', minQty: '', rate: '', from: '', to: '' })

  const loadEveryone = useCallback(async () => {
    setEveryone(await listItemPrices(db, {}))
  }, [db])
  useEffect(() => { void loadEveryone() }, [loadEveryone])

  useEffect(() => { void listPriceLists(db).then(setLists) }, [db])

  useEffect(() => {
    const id = setTimeout(async () => {
      setResults(term.trim() === '' ? [] : await searchProducts(db, { term, limit: 20 }))
    }, 140)
    return () => clearTimeout(id)
  }, [db, term])

  const load = useCallback(async (product: ProductListItem) => {
    setChosen(product)
    setResults([])
    setTerm('')
    setError(null)
    const [u, p] = await Promise.all([listUnits(db, product.id), listItemPrices(db, { productId: product.id })])
    setUnits(u)
    setPrices(p)
    setRow({
      priceListId: lists.find((l) => l.isDefault)?.id ?? lists[0]?.id ?? '',
      saleUnit: product.baseUnit, minQty: '', rate: '', from: '', to: '',
    })
  }, [db, lists])

  const unitOptions = useMemo(
    () => (chosen ? [{ saleUnit: chosen.baseUnit, baseUnits: Quantity.fromUnits(1) }, ...units] : []),
    [chosen, units],
  )

  async function add() {
    if (!chosen) return
    const rate = Money.parseMoney(row.rate)
    if (rate === null) { setError('That rate is not a number.'); return }

    const result = await setItemPrice(db, { actorId: user.id }, {
      productId: chosen.id,
      priceListId: row.priceListId,
      saleUnit: row.saleUnit,
      minQty: row.minQty.trim() === '' ? Quantity.qty(0) : (Quantity.parseQty(row.minQty) ?? Quantity.qty(0)),
      rate,
      validFrom: row.from || null,
      validTo: row.to || null,
    })
    if (!result.ok) {
      setError(
        result.code === 'BAD_DATES'
          ? 'The last day is before the first.'
          : `This item does not sell in ${row.saleUnit}. Add the unit on the Inventory screen first.`,
      )
      return
    }
    setError(null)
    setRow({ ...row, minQty: '', rate: '', from: '', to: '' })
    setPrices(await listItemPrices(db, { productId: chosen.id }))
    await loadEveryone()
  }

  async function drop(id: string) {
    if (!chosen) return
    await removeItemPrice(db, { actorId: user.id }, id)
    setPrices(await listItemPrices(db, { productId: chosen.id }))
    await loadEveryone()
  }

  /* The search box the results hang from. The list is portalled to the body,
     so this is how it knows where the box is. */
  const box = useRef<HTMLInputElement>(null)

  /** The rates gathered under their item, filtered by the box above. */
  const byProduct = useMemo(() => {
    const needle = look.trim().toLowerCase()
    const matching = needle === ''
      ? everyone
      : everyone.filter((r) =>
        r.productName.toLowerCase().includes(needle)
        || r.priceListName.toLowerCase().includes(needle))

    const groups = new Map<string, { id: string; name: string; rates: ItemPrice[] }>()
    for (const rate of matching) {
      const found = groups.get(rate.productId)
      if (found) found.rates.push(rate)
      else groups.set(rate.productId, { id: rate.productId, name: rate.productName, rates: [rate] })
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [everyone, look])

  /** Opens an item from the list, which knows its id and not its base rate. */
  const openProduct = useCallback(async (productId: string) => {
    const [found] = await productsByIds(db, [productId])
    if (found) await load(found)
  }, [db, load])

  const pick = usePickList({
    count: results.length,
    resetKey: term,
    onPick: (i) => { const hit = results[i]; if (hit) void load(hit) },
  })

  return (
    <>
      <Card title="Which item">
        <input className="input" id="price-search" autoFocus ref={box}
          placeholder="Search an item by name, code or barcode"
          value={term} onChange={(e) => setTerm(e.target.value)}
          onKeyDown={pick.searchKeyDown} />
        <Results anchor={box} open={results.length > 0}>
          <div {...pick.listProps}>
            {results.map((p, i) => (
              <div key={p.id} style={{ padding: '7px 10px' }} {...pick.rowProps(i)}>
                {p.name}
                <span style={{ float: 'right', color: 'var(--ink-3)' }}>
                  base <Rupees value={p.baseRate} /> / {p.baseUnit}
                </span>
              </div>
            ))}
          </div>
        </Results>
      </Card>

      {!chosen && (
        <Card title={`Rates already set — ${everyone.length} across ${byProduct.length} item${byProduct.length === 1 ? '' : 's'}`}>
          <input
            className="input" style={{ maxWidth: 380, marginBottom: 10 }}
            placeholder="Filter by item or price list"
            value={look} onChange={(e) => setLook(e.target.value)}
            aria-label="Filter the rates already set"
          />

          {byProduct.length === 0 ? (
            <Empty>
              {everyone.length === 0
                ? 'No item has a rate of its own yet. Search for one above to give it one.'
                : 'Nothing matches that.'}
            </Empty>
          ) : (
            <div className="card-scroll" style={{ maxHeight: 460 }}>
              <table>
                <thead>
                  <tr>
                    <th>Item</th><th>Price list</th><th>Unit</th>
                    {breaks && <th className="r">From qty</th>}
                    <th className="r">Rate</th><th>Until</th>
                  </tr>
                </thead>
                <tbody>
                  {byProduct.map((group) => group.rates.map((r, i) => (
                    <tr key={r.id}>
                      <td>
                        {i === 0 && (
                          <button className="btn ghost sm" onClick={() => void openProduct(r.productId)}>
                            {r.productName}
                          </button>
                        )}
                      </td>
                      <td>{r.priceListName}</td>
                      <td>{r.saleUnit}</td>
                      {breaks && <td className="r num">{r.minQty > 0 ? Quantity.formatQty(r.minQty) : '—'}</td>}
                      <td className="r"><Rupees value={r.rate} /></td>
                      <td className="num" style={{ color: 'var(--ink-3)' }}>{r.validTo ?? '—'}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {chosen && (
        <Card title={chosen.name}>
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
            Base rate <Rupees value={chosen.baseRate} /> per {chosen.baseUnit}, used when no rule below
            applies.{' '}
            {breaks
              ? 'A rate with a quantity applies from that quantity upwards, so a ladder is just several rows.'
              : 'One rate per list and unit. Turn on cheaper-by-the-quantity in Settings to price by how much is bought.'}
          </div>

          {error && <div style={{ marginBottom: 11 }}><Alert>{error}</Alert></div>}

          <table>
            <thead>
              <tr>
                <th>Price list</th><th>Unit</th>
                {breaks && <th className="r">From qty</th>}
                <th className="r">Rate</th><th className="r">Per {chosen.baseUnit}</th>
                <th>Dates</th><th />
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => {
                const unit = unitOptions.find((u) => u.saleUnit === p.saleUnit)
                return (
                  <tr key={p.id}>
                    <td>{p.priceListName}</td>
                    <td>{p.saleUnit}</td>
                    {breaks && <td className="r num">{p.minQty > 0 ? Quantity.formatQty(p.minQty) : '—'}</td>}
                    <td className="r"><Rupees value={p.rate} /></td>
                    <td className="r" style={{ color: 'var(--ink-3)' }}>
                      {unit ? <Rupees value={perBaseUnit(p.rate, unit.baseUnits)} /> : '—'}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                      {p.validFrom || p.validTo ? `${p.validFrom ?? '—'} → ${p.validTo ?? '—'}` : 'always'}
                    </td>
                    <td className="r">
                      {canWrite && <button className="btn ghost sm" onClick={() => void drop(p.id)}>Remove</button>}
                    </td>
                  </tr>
                )
              })}
              {prices.length === 0 && (
                <tr><td colSpan={breaks ? 7 : 6}><Empty>No rates yet — everyone pays the base rate</Empty></td></tr>
              )}
            </tbody>
          </table>

          {canWrite && (
            <div style={{ marginTop: 15, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 9 }}>Add a rate</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                <Field label="Price list">
                  <select className="input" value={row.priceListId}
                    onChange={(e) => setRow({ ...row, priceListId: e.target.value })}>
                    {lists.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isDefault ? ' (default)' : ''}</option>)}
                  </select>
                </Field>
                <Field label="Unit" hint="Add units to an item on the Inventory screen.">
                  <select className="input" value={row.saleUnit}
                    onChange={(e) => setRow({ ...row, saleUnit: e.target.value })}>
                    {unitOptions.map((u) => <option key={u.saleUnit} value={u.saleUnit}>{u.saleUnit}</option>)}
                  </select>
                </Field>
                {breaks && (
                  <Field label="From quantity" hint="Blank means it always applies.">
                    <input className="input num" value={row.minQty} inputMode="decimal"
                      onChange={(e) => setRow({ ...row, minQty: e.target.value })} />
                  </Field>
                )}
                <Field label="Rate">
                  <input className="input num" value={row.rate} inputMode="decimal"
                    onChange={(e) => setRow({ ...row, rate: e.target.value })} />
                </Field>
                <Field label="First day" hint="Blank for no start.">
                  <input className="input" type="date" value={row.from}
                    onChange={(e) => setRow({ ...row, from: e.target.value })} />
                </Field>
                <Field label="Last day" hint="Blank for no end.">
                  <input className="input" type="date" value={row.to}
                    onChange={(e) => setRow({ ...row, to: e.target.value })} />
                </Field>
              </div>
              <button className="btn primary" style={{ marginTop: 4 }}
                disabled={row.rate.trim() === ''} onClick={() => void add()}>
                Save this rate
              </button>
            </div>
          )}
        </Card>
      )}
    </>
  )
}
