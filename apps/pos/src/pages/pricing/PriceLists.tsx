import { useCallback, useEffect, useState } from 'react'
import {
  listPriceLists, createPriceList, updatePriceList, archivePriceList, restorePriceList,
  type PriceList,
} from '@shopos/core'
import { useDb, useUser } from '../../core/CoreProvider'
import { Card, Alert } from '../../ui/components'
import { useConfirm } from '../../ui/useConfirm'
import { useShopChanged } from '../../core/useShopChanged'

/* The second tab: the named lists themselves -- added, renamed, archived. */

export function PriceLists({ canWrite }: { canWrite: boolean }) {
  const db = useDb()
  const user = useUser()
  const [confirmUi, ask] = useConfirm()
  const [lists, setLists] = useState<PriceList[]>([])
  const [name, setName] = useState('')
  /** A new list quotes before tax -- a wholesale list. Off is a shelf price list. */
  const [beforeTax, setBeforeTax] = useState(false)
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
    const result = await createPriceList(db, { actorId: user.id }, { name, ratesIncludeTax: !beforeTax })
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
    setBeforeTax(false)
    await refresh()
  }

  /**
   * Turns a list from shelf prices to rates before tax, or back.
   *
   * Asked first, because every rate on the list is read the other way from the
   * next bill: a 100 that meant "100 with tax in it" becomes 100 plus tax.
   * Bills already made keep the way their lines were read.
   */
  async function flipTax(list: PriceList) {
    const next = !list.ratesIncludeTax
    if (!(await ask(
      next
        ? `Read the rates on ${list.name} as including tax?\n\nFrom the next bill, a rate of 100 is 100 with the tax in it.`
        : `Read the rates on ${list.name} as before tax?\n\nFrom the next bill, a rate of 100 is 100 plus GST and any cess.`,
    ))) return
    try {
      await updatePriceList(db, { actorId: user.id }, { priceListId: list.id, ratesIncludeTax: next })
    } catch (err) {
      setError(`That did not go through: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
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
          <tr>
            <th>Name</th><th className="r">Rates</th><th>Tax</th><th className="r">Customers</th><th>Default</th><th />
          </tr>
        </thead>
        <tbody>
          {lists.map((l) => (
            <tr key={l.id}>
              <td>
                {l.name}
                {l.archived && <span className="badge" style={{ marginLeft: 7 }}>removed</span>}
              </td>
              <td className="r num">{l.priceCount}</td>
              <td>
                {canWrite && !l.archived ? (
                  <button className="cell-btn" title="Change how this list's rates are read"
                    onClick={() => void flipTax(l)}>
                    {l.ratesIncludeTax ? 'Included' : 'Added on top'}
                  </button>
                ) : (l.ratesIncludeTax ? 'Included' : 'Added on top')}
              </td>
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
      {canWrite && (
        <label style={{ fontSize: 12.5, color: 'var(--ink-2)', display: 'flex', gap: 5, alignItems: 'center', marginTop: 8 }}>
          <input type="checkbox" checked={beforeTax} onChange={(e) => setBeforeTax(e.target.checked)} />
          Its rates are before tax, as a wholesaler quotes — GST is added on top at the counter
        </label>
      )}
    </Card>
  )
}
