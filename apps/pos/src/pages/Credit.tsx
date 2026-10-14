import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Money, searchCustomers, countCustomers, customerStatement, Permissions, totalOutstandingAll,
  listCustomerPayments, type CustomerListItem, type OutstandingTotal, type CustomerOrder,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Empty, Alert, Rupees, Stat } from '../ui/components'
import { usePickList } from '../ui/PickList'
import { useShopChanged } from '../core/useShopChanged'
import { takeAccountToOpen } from '../core/nav'
import { type Account, AccountPanel } from './credit/AccountPanel'
import { OpeningBalance } from './credit/OpeningBalance'

/**
 * The khata.
 *
 * This screen could take a payment and show a balance, and that was all — which
 * left the four things a shopkeeper actually does with credit unreachable, even
 * though three of them were already built into the engine and called by nothing:
 * settling a chosen bill rather than the oldest, undoing a receipt entered
 * against the wrong customer, and giving up on a debt that is not worth chasing.
 *
 * Laid out around the question being asked. The list is a collection round —
 * who owes, how long it has been, worst first. The panel is one customer's
 * account, where everything that can be done to it lives together rather than
 * behind separate buttons on separate screens.
 */

/**
 * How many names the list holds before it stops.
 *
 * It has always stopped here; what changed is that the page no longer pretends
 * otherwise. The three figures above the table are the whole shop's, from one
 * query, and the line under the table says when the table is short of it.
 */
const PAGE = 500

export default function Credit() {
  const { db, registerId } = useCore()
  const user = useUser()
  /* Taking money against the khata and unwinding a payment already taken are
     the two things on this screen that move money. Both had a permission and
     neither was ever read. */
  const canTake = Permissions.can(user.permissions, 'payment', 'create')
  const canUndo = Permissions.can(user.permissions, 'payment', 'cancel')
  const [customers, setCustomers] = useState<CustomerListItem[]>([])
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState<Account | null>(null)
  /* A statement is not only for people who owe. A customer who has paid up still
     wants the page — often more so, because it is the proof they have. */
  const [who, setWho] = useState<'owing' | 'everyone'>('owing')
  /**
   * Which end of the list to start at.
   *
   * Decided by the database, not by sorting the rows after they arrive: this
   * list stops at `PAGE`, so sorting what came back sorts an arbitrary five
   * hundred of six hundred, and the customer who owes the most may not be
   * among them. That is the failure that looks right on every screen you can
   * check it on.
   */
  const [order, setOrder] = useState<CustomerOrder>('owing')
  const [opening, setOpening] = useState<CustomerListItem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [everyone, setEveryone] = useState<CustomerListItem[]>([])
  /**
   * The whole shop, not the page of it below.
   *
   * The three stats used to be `shown.reduce(...)` over the five hundred rows
   * that happened to be loaded — so a shop with six hundred customers was told
   * what the first five hundred *by name* owed it, and told it in the words
   * "Total outstanding". Wrong in the direction that never looks alarming
   * enough to question. Two grouped passes now, over every customer there is.
   */
  const [book, setBook] = useState<OutstandingTotal | null>(null)
  const [known, setKnown] = useState(0)

  const refresh = useCallback(async () => {
    const [all, shopWide, howMany] = await Promise.all([
      searchCustomers(db, '', PAGE, { order }),
      totalOutstandingAll(db),
      countCustomers(db),
    ])
    setEveryone(all)
    /* Anybody the shop has something to settle with, either way round. A
       customer who is 490 in credit is exactly as much of a loose end as one
       who owes 490, and leaving them out of "Owing" put them on no list at
       all. */
    setCustomers(all.filter((c) => c.outstanding > 0 || c.advance > 0))
    setBook(shopWide)
    setKnown(howMany)
  }, [db, order])

  useEffect(() => { void refresh() }, [refresh])
  // And again whenever the other till sends something this list shows.
  useShopChanged(refresh)

  const shown = useMemo(() => {
    const list = who === 'owing' ? customers : everyone
    const t = term.trim().toLowerCase()
    if (t === '') return list
    return list.filter((c) =>
      c.name.toLowerCase().includes(t)
      || (c.phone ?? '').includes(t)
      || (c.code ?? '').toLowerCase().includes(t))
  }, [customers, everyone, who, term])

  const load = useCallback(async (customer: CustomerListItem) => {
    const [bills, payments] = await Promise.all([
      customerStatement(db, customer.id),
      listCustomerPayments(db, customer.id),
    ])
    setOpen({ customer, bills, payments })
  }, [db])

  // Arrived from a warning about this customer's payments: open their account.
  useEffect(() => {
    const id = takeAccountToOpen()
    if (id === null) return
    void searchCustomers(db, '', 10_000, { includeArchived: true })
      .then((all) => { const c = all.find((x) => x.id === id); if (c) void load(c) })
  }, [db, load])

  async function reload() {
    if (!open) return
    const fresh = (await searchCustomers(db, open.customer.phone ?? open.customer.name, 20))
      .find((c) => c.id === open.customer.id)
    await load(fresh ?? open.customer)
    await refresh()
  }

  function say(message: string) {
    setNotice(message)
    setTimeout(() => setNotice(null), 9000)
  }

  const pick = usePickList({
    count: shown.length,
    as: 'grid',
    resetKey: term,
    onPick: (i) => { const c = shown[i]; if (c) void load(c) },
  })

  /* The three numbers that decide whether today is a collection day, and the
     one customer to start with. All of them about the shop, none of them about
     this page of it. */
  const total = book?.total ?? Money.ZERO
  const worst = book?.worst ?? null
  const overLimit = book?.overLimit ?? 0
  const owing = book?.customers ?? 0

  /* Whether the table is showing everything it is summarising. Searching
     narrows the table and not the figures above it, which is the honest way
     round — "Total outstanding" is a fact about the shop, not about what has
     been typed into a box. */
  const listed = who === 'owing' ? customers.length : everyone.length
  const short = term.trim() === '' && (who === 'owing' ? owing > listed : known > listed)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {notice && <Alert kind="ok">{notice}</Alert>}

      <div className="stat-row">
        <Stat
          label="Total outstanding"
          value={<span className="num">{Money.formatWithSymbol(total)}</span>}
          sub={owing === 0
            ? 'Nobody owes anything'
            : `${owing} ${owing === 1 ? 'customer owes' : 'customers owe'} money`}
        />
        <Stat
          label="Owes the most"
          value={worst ? worst.name : '—'}
          sub={worst ? Money.formatWithSymbol(worst.outstanding) : 'Nothing outstanding'}
        />
        <Stat
          label="Over their limit"
          value={<span className="num">{overLimit}</span>}
          sub={overLimit === 0 ? 'Everyone is within it' : 'Selling on credit is blocked for these'}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div className="segment">
          <button type="button" aria-pressed={who === 'owing'} onClick={() => setWho('owing')}>
            Owing ({owing})
          </button>
          <button type="button" aria-pressed={who === 'everyone'} onClick={() => setWho('everyone')}>
            Everyone ({known})
          </button>
        </div>
        <input className="input" style={{ maxWidth: 340 }}
          placeholder="Search by name, phone or customer code"
          value={term} onChange={(e) => setTerm(e.target.value)} id="credit-search" />

        <select
          className="input" style={{ maxWidth: 190 }} value={order}
          aria-label="Sort the list"
          onChange={(e) => setOrder(e.target.value as CustomerOrder)}
        >
          <option value="owing">Most owed first</option>
          <option value="name">By name</option>
          <option value="oldest">Quietest first</option>
        </select>

        <span style={{ flex: 1 }} />
        {canTake && (
          <button className="btn" onClick={() => setOpening(everyone[0] ?? null)} disabled={everyone.length === 0}>
            Opening balance
          </button>
        )}
      </div>

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 90 }}>Code</th>
              <th>Customer</th><th>Phone</th>
              <th className="r">Limit</th><th className="r">Outstanding</th><th />
            </tr>
          </thead>
          <tbody {...pick.listProps}>
            {shown.map((c, i) => (
              <tr key={c.id} {...pick.rowProps(i)}>
                <td className="num" style={{ color: 'var(--ink-2)' }}>{c.code ?? '—'}</td>
                <td>{c.name}</td>
                <td className="num">{c.phone ?? '—'}</td>
                <td className="r">
                  {c.creditLimit > 0
                    ? <Rupees value={c.creditLimit} />
                    : <span style={{ color: 'var(--ink-3)' }}>none</span>}
                </td>
                <td className="r">
                  <Rupees value={c.outstanding} />
                  {c.creditLimit > 0 && c.outstanding > c.creditLimit && (
                    <span className="badge bad" style={{ marginLeft: 7 }}>over limit</span>
                  )}
                  {/* Money the shop is holding for them. It has always been in
                      the database and on no screen, so somebody who had paid
                      ahead read here as owing nothing — true, and not the whole
                      truth, because the shop owes them. */}
                  {c.advance > 0 && (
                    <div className="src">{Money.formatWithSymbol(c.advance)} in credit</div>
                  )}
                </td>
                <td className="r">
                  <button className="btn sm" onClick={() => void load(c)}>Open account</button>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <Empty>
                    {term ? 'Nobody matches' : who === 'owing' ? 'Nobody owes anything' : 'No customers yet'}
                  </Empty>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {short && (
        /* The figures above are the whole shop's and this table is not, so it
           has to say so. Without this line the page contradicts itself in
           public: a total of one amount over a list that visibly adds to less,
           and no explanation anywhere on the screen. */
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
          Showing {listed} of {who === 'owing' ? owing : known}. Search by name, phone
          or code to reach anyone not on the list.
        </div>
      )}

      {open && (
        <AccountPanel
          account={open}
          registerId={registerId}
          actorId={user.id}
          canTake={canTake}
          canUndo={canUndo}
          onClose={() => setOpen(null)}
          onChanged={async (message) => { say(message); await reload() }}
        />
      )}

      {opening && (
        <OpeningBalance
          customers={everyone}
          registerId={registerId}
          actorId={user.id}
          onClose={() => setOpening(null)}
          onDone={async (message) => { setOpening(null); say(message); await refresh() }}
        />
      )}
    </div>
  )
}
