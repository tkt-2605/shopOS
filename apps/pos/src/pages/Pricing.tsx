import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  listPriceLists, createPriceList, updatePriceList, archivePriceList, restorePriceList,
  listItemPrices, setItemPrice, removeItemPrice,
  listCustomerPrices, removeCustomerPrice, setCustomerPriceList,
  setCustomerLadder, customerLadderFor, listUnits, perBaseUnit, Ladder,
  searchProducts, searchCustomers, productsByIds, Money, Quantity, Permissions,
  type PriceList, type ItemPrice, type CustomerPrice, type SaleUnit,
  type ProductListItem, type CustomerListItem,
} from '@shopos/core'
import { useCore, useDb, useUser } from '../core/CoreProvider'
import { Card, Field, Empty, Alert, Rupees } from '../ui/components'
import { useConfirm } from '../ui/useConfirm'
import { LadderEditor, describeRowsProblem, type LadderRow } from '../ui/LadderEditor'
import { usePickList, Results } from '../ui/PickList'
import { useShopChanged } from '../core/useShopChanged'

/**
 * Where prices are set.
 *
 * The engine that reads these has existed since v1 — a four-step chain from a
 * customer's own rate, through their price list, through the shop's list, down
 * to the item's base rate, with quantity tiers and validity dates at each step.
 * Until now nothing could write to it but the demo seed, which meant a shop
 * could be told it had tiered pricing and never find it.
 *
 * Laid out item-first, because that is the question a shopkeeper actually has:
 * not "what is on the wholesale list" but "what does this pen cost, and to
 * whom".
 */

type Tab = 'items' | 'lists' | 'customers'

const TABS: { id: Tab; label: string; what: string }[] = [
  {
    id: 'items',
    label: 'Rates per item',
    what: 'Pick an item and say what it costs on each list, and at what quantity. '
      + 'This is where “₹9 each, ₹8 from a dozen” is set.',
  },
  {
    id: 'lists',
    label: 'Price lists',
    what: 'The named groups of rates — Retail, Wholesale, School. A list on its own '
      + 'does nothing until items are given rates on it and a customer is put on it.',
  },
  {
    id: 'customers',
    label: 'Rates per customer',
    what: 'Put a customer on a list, or give one customer a rate nobody else gets.',
  },
]

export default function Pricing() {
  const user = useUser()
  const [tab, setTab] = useState<Tab>('items')
  const canWrite = Permissions.can(user.permissions, 'price_list', 'write')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1000 }}>
      {/* A screen whose name is a noun and whose job is not obvious from it.
          The first sentence is the one that matters: it says what this page is
          NOT, because the ordinary price of an item lives on Inventory and
          that is where a shopkeeper looking for "prices" has already been. */}
      <div
        style={{
          border: '1px solid var(--rule-strong)', background: 'var(--surface)',
          padding: '13px 15px', fontSize: 13, lineHeight: 1.55,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          This is not where an item’s normal price is set.
        </div>
        <p style={{ margin: '0 0 9px' }}>
          That one lives on the item itself, under <strong>Inventory</strong>. This page is for
          selling the same thing at a <em>different</em> price to somebody — a cheaper rate by
          the dozen, a wholesale list for the trade, a rate you agreed with one school.
          Set nothing here and every sale is at the normal price. Nothing is broken by leaving
          it empty.
        </p>
        <p style={{ margin: '0 0 9px' }}>
          <strong>For example.</strong> A pen is ₹10 in Inventory. Here you make a list called
          Wholesale where that pen is ₹8, and put Sri Vidya School on it. From then on the pen
          rings up at ₹8 for the school and ₹10 for everybody else, with nobody at the counter
          having to remember it.
        </p>
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
          For every line it bills, the counter takes the first of these that has an answer:
          {' '}<strong>this customer’s own rate</strong> → <strong>their price list</strong>
          {' '}→ <strong>the shop’s default list</strong> → <strong>the item’s normal price</strong>.
        </div>
      </div>

      <div>
        <div className="segment">
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {/* Three nouns that all sound like the same thing. Each says its own job
            rather than leaving the shop to work out how they differ. */}
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 8, lineHeight: 1.5 }}>
          {TABS.find((t) => t.id === tab)!.what}
        </div>
      </div>

      {!canWrite && <Alert kind="warn">You can see prices here but not change them.</Alert>}

      {tab === 'items' && <ItemPrices canWrite={canWrite} />}
      {tab === 'lists' && <PriceLists canWrite={canWrite} />}
      {tab === 'customers' && <CustomerRates canWrite={canWrite} />}
    </div>
  )
}

/* --------------------------------------------------------- item prices --- */

function ItemPrices({ canWrite }: { canWrite: boolean }) {
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

/* --------------------------------------------------------- price lists --- */

function PriceLists({ canWrite }: { canWrite: boolean }) {
  const db = useDb()
  const user = useUser()
  const [confirmUi, ask] = useConfirm()
  const [lists, setLists] = useState<PriceList[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const refresh = useCallback(
    async () => setLists(await listPriceLists(db, { includeArchived: showArchived })),
    [db, showArchived],
  )
  useEffect(() => { void refresh() }, [refresh])
  // And again whenever the other till sends something this list shows.
  useShopChanged(refresh)

  async function add() {
    const result = await createPriceList(db, { actorId: user.id }, { name })
    if (!result.ok) {
      /* The archived clash is its own message because it has its own answer.
         The name is still taken -- the row is still there -- and telling a shop
         only that leaves them typing "Wholesale 2" beside a Wholesale they
         cannot see. */
      setError(
        result.code === 'NO_NAME' ? 'Give the list a name.'
        : result.code === 'NAME_TAKEN_ARCHIVED'
          ? `There is a list called “${name.trim()}” that was taken off this screen. `
            + 'Tick “Show the ones taken off the list” and bring it back — its rates are all still on it.'
        : 'There is already a list with that name.',
      )
      return
    }
    setError(null)
    setName('')
    await refresh()
  }

  async function makeDefault(priceListId: string) {
    await updatePriceList(db, { actorId: user.id }, { priceListId, isDefault: true })
    await refresh()
  }

  /**
   * Off the screen, and back onto it.
   *
   * The rates stay. That is the whole reason this is safe to press: a list that
   * comes back comes back priced, and every bill ever written from it can still
   * be explained, because `item_prices` was never touched.
   */
  async function archive(list: PriceList) {
    setError(null)

    if (list.archived) {
      await restorePriceList(db, { actorId: user.id }, list.id)
      await refresh()
      return
    }

    if (!(await ask(
      `Take ${list.name} off this screen?\n\n`
      + 'The rates on it are kept, and old bills priced from it can still be '
      + 'explained. You can bring it back here.',
    ))) return

    const result = await archivePriceList(db, { actorId: user.id }, list.id)
    if (!result.ok) {
      setError(
        result.code === 'IS_DEFAULT'
          ? 'This is the shop’s default list — what a walk-in customer pays. '
            + 'Make another list the default first, then take this one off.'
          : `${result.customerCount === 1 ? 'One customer buys' : `${result.customerCount} customers buy`} `
            + 'on this list. Taking it off would move them to the default list and change '
            + 'what they are charged, without anyone deciding to. Move them first, under '
            + '“Rates per customer”.',
      )
      return
    }
    await refresh()
  }

  return (
    <Card title="Price lists">
      {confirmUi}
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
        A list is a set of rates. The default one is what a walk-in customer pays; put a customer on
        another and they get its rates instead. Every shop has exactly one default.
      </div>

      {error && <div style={{ marginBottom: 11 }}><Alert>{error}</Alert></div>}

      <label style={{
        fontSize: 12.5, color: 'var(--ink-2)', display: 'flex', gap: 5,
        alignItems: 'center', marginBottom: 10,
      }}>
        <input
          type="checkbox" checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        Show the ones taken off the list
      </label>

      <table>
        <thead>
          <tr><th>Name</th><th className="r">Rates</th><th className="r">Customers</th><th>Default</th><th /></tr>
        </thead>
        <tbody>
          {lists.map((l) => (
            <tr key={l.id}>
              <td>
                {l.name}
                {l.archived && <span className="badge" style={{ marginLeft: 7 }}>removed</span>}
              </td>
              <td className="r num">{l.priceCount}</td>
              <td className="r num">{l.customerCount}</td>
              <td>{l.isDefault ? <span className="badge ok">default</span> : ''}</td>
              <td className="r" style={{ whiteSpace: 'nowrap' }}>
                {canWrite && !l.isDefault && !l.archived && (
                  <button className="btn ghost sm" onClick={() => void makeDefault(l.id)}>Make default</button>
                )}
                {canWrite && !l.isDefault && (
                  <button className="btn ghost sm" onClick={() => void archive(l)}>
                    {l.archived ? 'Bring back' : 'Remove'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canWrite && (
        <div style={{ display: 'flex', gap: 6, marginTop: 14, maxWidth: 420 }}>
          <input className="input" placeholder="New list — Wholesale, Festival, Staff"
            value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button className="btn" disabled={name.trim() === ''} onClick={() => void add()}>Add</button>
        </div>
      )}
    </Card>
  )
}

/* ------------------------------------------------------ customer rates --- */

function CustomerRates({ canWrite }: { canWrite: boolean }) {
  const db = useDb()
  const breaks = useCore().features.tieredPricing
  const user = useUser()
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<CustomerListItem[]>([])
  const [chosen, setChosen] = useState<CustomerListItem | null>(null)
  const [lists, setLists] = useState<PriceList[]>([])
  const [onList, setOnList] = useState('')
  const [rates, setRates] = useState<CustomerPrice[]>([])
  const [productTerm, setProductTerm] = useState('')
  const [productResults, setProductResults] = useState<ProductListItem[]>([])
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

  useEffect(() => {
    const id = setTimeout(async () => {
      setResults(term.trim() === '' ? [] : await searchCustomers(db, term, 20))
    }, 140)
    return () => clearTimeout(id)
  }, [db, term])

  useEffect(() => {
    const id = setTimeout(async () => {
      setProductResults(productTerm.trim() === '' ? [] : await searchProducts(db, { term: productTerm, limit: 15 }))
    }, 140)
    return () => clearTimeout(id)
  }, [db, productTerm])

  async function choose(customer: CustomerListItem) {
    await chooseById(customer.id, customer.name)
  }

  /**
   * By id and name, so the list below can open a customer it already knows
   * without a second round trip to look one up it has the name of.
   */
  async function chooseById(id: string, name: string) {
    setChosen({ id, name } as CustomerListItem)
    setResults([])
    setTerm('')
    setRates(await listCustomerPrices(db, { customerId: id }))
    const row = await db.get<{ price_list_id: string | null }>(
      `SELECT price_list_id FROM customers WHERE id = ?`, [id],
    )
    setOnList(row?.price_list_id ?? '')
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
    setProductResults([])
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
  })

  const productPick = usePickList({
    count: productResults.length,
    resetKey: productTerm,
    onPick: (i) => { const hit = productResults[i]; if (hit) void pickProduct(hit) },
  })

  return (
    <>
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
