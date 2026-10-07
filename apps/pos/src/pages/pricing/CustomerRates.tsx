import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  listPriceLists, listCustomerPrices, removeCustomerPrice, setCustomerPriceList,
  customerPriceListId, setCustomerLadder, customerLadderFor, listUnits, Ladder, searchProducts,
  searchCustomers, Quantity, type PriceList, type CustomerPrice, type SaleUnit,
  type ProductListItem, type CustomerListItem,
} from '@shopos/core'
import { useCore, useDb, useUser } from '../../core/CoreProvider'
import { Card, Field, Empty, Alert, Rupees } from '../../ui/components'
import { LadderEditor, describeRowsProblem, type LadderRow } from '../../ui/LadderEditor'
import { usePickList, Results } from '../../ui/PickList'
import { useSearch } from '../../ui/useSearch'
import { useScanChoice } from '../../ui/ScanChoice'

/* The third tab: a customer's list, and the rates only they get. */

export function CustomerRates({ canWrite }: { canWrite: boolean }) {
  const db = useDb()
  const breaks = useCore().features.tieredPricing
  const user = useUser()
  const [term, setTerm] = useState('')
  const [chosen, setChosen] = useState<CustomerListItem | null>(null)
  const [lists, setLists] = useState<PriceList[]>([])
  const [onList, setOnList] = useState('')
  const [rates, setRates] = useState<CustomerPrice[]>([])
  const [productTerm, setProductTerm] = useState('')
  const [picked, setPicked] = useState<{ product: ProductListItem; units: SaleUnit[] } | null>(null)
  const [saleUnit, setSaleUnit] = useState('')
  const [ladder, setLadder] = useState<LadderRow[]>([])
  const [error, setError] = useState<string | null>(null)
  /**
   * Every special price in the shop, for the list below.
   *
   * Held separately from `rates`, which is one customer's. Before this, the
   * only way to find out whether anybody had a special price on anything was
   * to search customers one at a time and look — so a rate agreed two years
   * ago by somebody who has left was invisible until it appeared on a bill.
   */
  const [everyone, setEveryone] = useState<CustomerPrice[]>([])
  const [look, setLook] = useState('')

  const loadEveryone = useCallback(async () => {
    setEveryone(await listCustomerPrices(db, {}))
  }, [db])

  useEffect(() => { void listPriceLists(db).then(setLists) }, [db])
  useEffect(() => { void loadEveryone() }, [loadEveryone])

  const customerSearch = useSearch(term, (t) => searchCustomers(db, t, 20))
  const results = customerSearch.rows

  const productSearch = useSearch(productTerm, (t) => searchProducts(db, { term: t, limit: 15 }))
  const productResults = productSearch.rows

  async function choose(customer: CustomerListItem) {
    await chooseById(customer.id, customer.name)
  }

  /**
   * By id and name, so the list below can open a customer it already knows
   * without a second round trip to look one up it has the name of.
   */
  async function chooseById(id: string, name: string) {
    setChosen({ id, name } as CustomerListItem)
    setTerm('')
    setRates(await listCustomerPrices(db, { customerId: id }))
    setOnList(await customerPriceListId(db, id) ?? '')
  }

  async function pickProduct(product: ProductListItem) {
    if (!chosen) return
    const units = await listUnits(db, product.id)
    setPicked({ product, units })
    setSaleUnit(product.baseUnit)
    // Whatever this customer already has for it, in the form it is typed in.
    setLadder(Ladder.rungsToRows(await customerLadderFor(db, {
      customerId: chosen.id, productId: product.id, saleUnit: product.baseUnit,
    })))
    setProductTerm('')
  }

  async function moveList(priceListId: string) {
    if (!chosen) return
    setOnList(priceListId)
    await setCustomerPriceList(db, { actorId: user.id }, chosen.id, priceListId || null)
  }

  async function add() {
    if (!chosen || !picked) return
    const parsed = Ladder.rowsToRungs(ladder)
    if (!parsed.ok) {
      setError(describeRowsProblem(parsed, saleUnit) ?? 'The prices need checking.')
      return
    }

    const result = await setCustomerLadder(db, { actorId: user.id }, {
      customerId: chosen.id, productId: picked.product.id, saleUnit, rungs: parsed.rungs,
    })
    if (!result.ok) {
      setError(result.code === 'BAD_DATES' ? 'The last day is before the first.' : `That item does not sell in ${saleUnit}.`)
      return
    }
    setError(null)
    setPicked(null)
    setLadder([])
    setRates(await listCustomerPrices(db, { customerId: chosen.id }))
    await loadEveryone()
  }

  async function drop(id: string) {
    if (!chosen) return
    await removeCustomerPrice(db, { actorId: user.id }, id)
    setRates(await listCustomerPrices(db, { customerId: chosen.id }))
    await loadEveryone()
  }

  const box = useRef<HTMLInputElement>(null)
  const itemBox = useRef<HTMLInputElement>(null)

  /**
   * The same rows, gathered under the customer they belong to and sorted by
   * name — which is the order somebody looking for "did we give Kumar a
   * rate?" reads in. `listCustomerPrices` already orders within a customer.
   */
  const byCustomer = useMemo(() => {
    const needle = look.trim().toLowerCase()
    const matching = needle === ''
      ? everyone
      : everyone.filter((r) =>
        r.customerName.toLowerCase().includes(needle)
        || r.productName.toLowerCase().includes(needle))

    const groups = new Map<string, { id: string; name: string; rates: CustomerPrice[] }>()
    for (const rate of matching) {
      const found = groups.get(rate.customerId)
      if (found) found.rates.push(rate)
      else groups.set(rate.customerId, { id: rate.customerId, name: rate.customerName, rates: [rate] })
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [everyone, look])

  const customerPick = usePickList({
    count: results.length,
    resetKey: term,
    onPick: (i) => { const hit = results[i]; if (hit) void choose(hit) },
    enter: async () => { const [hit] = await customerSearch.latest(); if (hit) await choose(hit) },
  })

  const scanChoice = useScanChoice((p) => void pickProduct(p))
  const productPick = usePickList({
    count: productResults.length,
    resetKey: productTerm,
    onPick: (i) => { const hit = productResults[i]; if (hit) void pickProduct(hit) },
    enter: async () => {
      const rows = await productSearch.latest()
      if (scanChoice.ask(rows, productTerm.trim())) return
      if (rows[0]) await pickProduct(rows[0])
    },
  })

  return (
    <>
      {scanChoice.dialog}
      <Card title="Which customer">
        <input className="input" ref={box} placeholder="Search a customer by name or phone"
          value={term} onChange={(e) => setTerm(e.target.value)}
          onKeyDown={customerPick.searchKeyDown} />
        <Results anchor={box} open={results.length > 0}>
          <div {...customerPick.listProps}>
            {results.map((c, i) => (
              <div key={c.id} style={{ padding: '7px 10px' }} {...customerPick.rowProps(i)}>
                {c.name}<span style={{ float: 'right', color: 'var(--ink-3)' }}>{c.phone ?? ''}</span>
              </div>
            ))}
          </div>
        </Results>
      </Card>

      {!chosen && (
        <Card title={`Special prices — ${everyone.length} across ${byCustomer.length} customer${byCustomer.length === 1 ? '' : 's'}`}>
          <input
            className="input" style={{ maxWidth: 380, marginBottom: 10 }}
            placeholder="Filter by customer or item"
            value={look} onChange={(e) => setLook(e.target.value)}
            aria-label="Filter the special prices"
          />

          {byCustomer.length === 0 ? (
            <Empty>
              {everyone.length === 0
                ? 'No customer has a price of their own yet. Search for one above to give them one.'
                : 'Nothing matches that.'}
            </Empty>
          ) : (
            <div className="card-scroll" style={{ maxHeight: 460 }}>
            <table>
              <thead>
                <tr>
                  <th>Customer</th><th>Item</th><th>Unit</th>
                  <th className="r">From qty</th><th className="r">Rate</th><th>Until</th>
                </tr>
              </thead>
              <tbody>
                {byCustomer.map((group) => group.rates.map((r, i) => (
                  <tr key={r.id}>
                    {/* The name once per customer rather than once per row:
                        a customer with nine special items is one agreement,
                        and nine repetitions of their name reads as nine. */}
                    <td>
                      {i === 0 && (
                        <button className="btn ghost sm" onClick={() => void chooseById(group.id, group.name)}>
                          {group.name}
                        </button>
                      )}
                    </td>
                    <td>{r.productName}</td>
                    <td>{r.saleUnit ?? ''}</td>
                    <td className="r num">{r.minQty > 0 ? Quantity.formatQty(r.minQty) : '—'}</td>
                    <td className="r"><Rupees value={r.rate} /></td>
                    <td className="num">{r.validTo ?? ''}</td>
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
          {error && <div style={{ marginBottom: 11 }}><Alert>{error}</Alert></div>}

          <Field label="Price list" hint="Everything this customer buys comes off this list, unless an item below says otherwise.">
            <select className="input" value={onList} disabled={!canWrite}
              onChange={(e) => void moveList(e.target.value)} style={{ maxWidth: 320 }}>
              <option value="">The shop's default list</option>
              {lists.filter((l) => !l.isDefault).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>

          <div style={{ fontSize: 12.5, fontWeight: 600, margin: '15px 0 3px' }}>Rates only this customer gets</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 7 }}>
            {breaks ? (
              <>
                These beat every list. Below the lowest quantity here the customer falls back to
                their list, which is what makes a ladder starting at ten mean &ldquo;only when they
                take ten&rdquo;.
              </>
            ) : (
              <>These beat every list. One rate per item and unit.</>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Item</th><th>Unit</th>
                {breaks && <th className="r">From qty</th>}
                <th className="r">Rate</th><th />
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id}>
                  <td>{r.productName}</td>
                  <td>{r.saleUnit}</td>
                  {breaks && <td className="r num">{r.minQty > 0 ? Quantity.formatQty(r.minQty) : '—'}</td>}
                  <td className="r"><Rupees value={r.rate} /></td>
                  <td className="r">
                    {canWrite && <button className="btn ghost sm" onClick={() => void drop(r.id)}>Remove</button>}
                  </td>
                </tr>
              ))}
              {rates.length === 0 && (
                <tr><td colSpan={breaks ? 5 : 4}><Empty>Nothing special — they pay their list's rates</Empty></td></tr>
              )}
            </tbody>
          </table>

          {canWrite && (
            <div style={{ marginTop: 15, paddingTop: 13, borderTop: '1px solid var(--rule-soft)' }}>
              {!picked ? (
                <div style={{ maxWidth: 420 }}>
                  <input className="input" ref={itemBox} placeholder="Add a rate — search the item"
                    value={productTerm} onChange={(e) => setProductTerm(e.target.value)}
                    onKeyDown={productPick.searchKeyDown} />
                  <Results anchor={itemBox} open={productResults.length > 0}>
                    <div {...productPick.listProps}>
                      {productResults.map((p, i) => (
                        <div key={p.id} style={{ padding: '7px 10px' }}
                          {...productPick.rowProps(i)}>{p.name}</div>
                      ))}
                    </div>
                  </Results>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 180 }}>
                    <div style={{ fontSize: 12.5, marginBottom: 4 }}>{picked.product.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                      base <Rupees value={picked.product.baseRate} />
                    </div>
                  </div>
                  <Field label="Unit">
                    <select className="input" value={saleUnit} onChange={(e) => setSaleUnit(e.target.value)}>
                      <option value={picked.product.baseUnit}>{picked.product.baseUnit}</option>
                      {picked.units.map((u) => <option key={u.saleUnit} value={u.saleUnit}>{u.saleUnit}</option>)}
                    </select>
                  </Field>
                  <Field label="What they pay">
                    <div style={{ minWidth: 300 }}>
                      <LadderEditor rows={ladder} unit={saleUnit} breaks={breaks} onChange={setLadder} />
                    </div>
                  </Field>
                  <button className="btn primary" onClick={() => void add()}>Save</button>
                  <button className="btn ghost" onClick={() => { setPicked(null); setLadder([]) }}>Cancel</button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </>
  )
}
