import { useEffect, useState } from 'react'
import { Permissions, type Page } from '@shopos/core'
import { useCore } from './core/CoreProvider'
import { Field, Alert, Empty } from './ui/components'
import { RestorePanel } from './ui/RestorePanel'
import { JoinShop } from './ui/JoinShop'
import { lookAround, type FoundTill } from './core/syncHost'
import { DeviceTroubleBanner } from './ui/DeviceTrouble'
import { OutOfDateBanner } from './ui/OutOfDateBanner'
import { PageErrorBoundary } from './ui/ErrorBoundary'
import { BackupDot } from './ui/BackupDot'
import { ChangePassword } from './ui/ChangePassword'
import { onRepeat } from './core/repeat'
import { onGoTo } from './core/nav'
import { appVersion, shopLine, type AppVersion } from './core/version'
import { ICONS, BrandMark } from './ui/icons'
import { AdminGate } from './ui/AdminGate'
import { CounterGate } from './ui/CounterGate'
import { JoinRequestPrompt } from './ui/JoinRequestPrompt'
import { Formats } from './pages/Formats'
import { lock } from './core/adminGate'
import Billing from './pages/Billing'
import Bills from './pages/Bills'
import Dashboard from './pages/Dashboard'
import Inventory from './pages/Inventory'
import StockIn from './pages/StockIn'
import Credit from './pages/Credit'
import CashCounter from './pages/CashCounter'
import Settings from './pages/Settings'
import Customers from './pages/Customers'
import Registers from './pages/Registers'
import Reports from './pages/Reports'
import Staff from './pages/Staff'
import Roles from './pages/Roles'
import Suppliers from './pages/Suppliers'
import StockCount from './pages/StockCount'
import Reorder from './pages/Reorder'
import Pricing from './pages/Pricing'
import Audit from './pages/Audit'
import Orders from './pages/Orders'
import PurchaseOrders from './pages/PurchaseOrders'
import { CouldNotStart } from './entry/CouldNotStart'
import { Login } from './entry/Login'
import { UpdateLine } from './ui/UpdateLine'

/* Grouped by what the person is doing, rather than one flat list of every screen.
   A cashier lives in Sell and never opens Setup. */
const NAV_GROUPS: { label: string; pages: Page[] }[] = [
  { label: 'Sell', pages: ['billing', 'bills', 'orders', 'customers'] },
  { label: 'Stock', pages: ['inventory', 'stock_in', 'stock_count', 'reorder', 'purchase_orders', 'suppliers'] },
  { label: 'Money', pages: ['credit', 'cash_counter'] },
  { label: 'Review', pages: ['dashboard', 'reports', 'audit'] },
  { label: 'Setup', pages: ['pricing', 'formats', 'settings'] },
]

/* Counters, Staff and Roles are deliberately absent from the sidebar: six
   entries under Setup all read as "settings", and those three are opened twice
   a year. They are still routable pages with their own permissions, reached
   from the "Set up" card on Settings.

   Bill Formats is a section of Settings, named in its own list beside the shop
   details and the printer. It stays in the sidebar only for a role that was
   given Bill Formats and not Settings -- otherwise that role would have no way
   to reach the one screen it was granted. */

const PAGE_TITLES: Record<string, string> = {
  dashboard: 'Dashboard',
  billing: 'Billing',
  bills: 'Bills',
  inventory: 'Inventory',
  stock_in: 'Stock In',
  stock_count: 'Stock Count',
  reorder: 'Buying List',
  suppliers: 'Suppliers',
  customers: 'Customers',
  credit: 'Credit',
  cash_counter: 'Cash Counter',
  /* Not "Prices". The ordinary price of an item is on the Inventory screen,
     and a shopkeeper looking for it went here and found something else. This
     page is for the prices that are not the ordinary one. */
  pricing: 'Special Prices',
  orders: 'Quotations & Orders',
  purchase_orders: 'Purchase Orders',
  registers: 'Counters',
  reports: 'Reports',
  audit: 'History',
  users: 'Staff',
  roles: 'Roles & Permissions',
  formats: 'Bill Formats',
  settings: 'Settings',
}

export default function App() {
  const { status, user } = useCore()
  if (status.phase === 'starting') return <Empty>Starting…</Empty>
  if (status.phase === 'failed') return <CouldNotStart error={status.error} kind={status.kind} />
  if (status.phase === 'setup') return <Setup />
  if (!user) return <Login />
  return <Shell />
}

/**
 * The first screen a machine ever shows, and it has three doors.
 *
 * It used to have one, which created a shop. That is right for the first
 * machine in a shop and wrong for every one after it: a second till that sets
 * itself up has made a *second shop*, with its own Admin role and its own
 * counter under the same names, and the two can never be merged. The refusal
 * exists (`DIFFERENT_SHOP`) and arrives after the day's work is in the wrong
 * database.
 *
 * So the machine asks the network first. If a till answers, joining is the
 * offer that leads; if none does, setting up is. Discovery decides which door
 * is obvious and never decides for anybody -- a shop opening its second branch
 * on the same network still has to be able to say "no, a new shop".
 */
function Setup() {
  const [door, setDoor] = useState<'asking' | 'new' | 'join' | 'restore'>('asking')

  if (door === 'join') return <JoinPanel onCancel={() => setDoor('asking')} />
  if (door === 'restore') return <RestoreDoor onCancel={() => setDoor('asking')} />
  if (door === 'new') return <NewShop onCancel={() => setDoor('asking')} />
  return <WhichDoor choose={setDoor} />
}

function WhichDoor({ choose }: { choose: (door: 'new' | 'join' | 'restore') => void }) {
  const [neighbours, setNeighbours] = useState<FoundTill[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void lookAround().then(
      (tills) => { if (!cancelled) setNeighbours(tills) },
      // A network that will not answer is not a reason to hold up setting up a
      // shop. The join door stays; it just has nothing to suggest.
      () => { if (!cancelled) setNeighbours([]) },
    )
    return () => { cancelled = true }
  }, [])

  const here = neighbours?.[0]

  return (
    <div className="centre">
      <div className="panel">
        <div className="panel-head">
          <h1>ShopOS</h1>
          <p>{here
            ? 'There is already a till on this network.'
            : 'Nothing else is running on this network.'}</p>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {here && (
            <button className="btn primary lg" onClick={() => choose('join')}>
              Join {here.shop ?? 'that shop'}
            </button>
          )}
          <button
            className={here ? 'btn lg' : 'btn primary lg'}
            onClick={() => choose('new')}
          >
            Set up a new shop
          </button>
          {!here && (
            <button className="btn lg" onClick={() => choose('join')}>
              Join a shop on another till
            </button>
          )}
          <button className="btn ghost" onClick={() => choose('restore')}>
            Restore a backup
          </button>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4, lineHeight: 1.6 }}>
            A second counter <strong>joins</strong>. Setting up again makes a
            separate shop, and two shops cannot be merged afterwards.
          </p>
        </div>
      </div>
    </div>
  )
}

function JoinPanel({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="centre">
      <div className="panel" style={{ maxWidth: 560 }}>
        <div className="panel-head">
          <h1>Join a shop</h1>
          <p>This machine becomes another counter of a shop that already exists.</p>
        </div>
        <JoinShop onCancel={onCancel} />
      </div>
    </div>
  )
}

/**
 * Restore, before anybody has signed in.
 *
 * The panel already had to work here -- a database this build cannot read fails
 * before the login screen, which is why `CouldNotStart` carries it. What was
 * missing is the case where the machine is fine and the shop is in a zip: a
 * replacement till, or one being rebuilt.
 */
function RestoreDoor({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="centre">
      <div className="panel" style={{ maxWidth: 620 }}>
        <div className="panel-head">
          <h1>Restore a backup</h1>
          <p>The shop comes back exactly as the backup left it, staff and all.</p>
        </div>
        <div className="panel-body">
          <RestorePanel standalone />
          <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={onCancel}>
            Back
          </button>
        </div>
      </div>
    </div>
  )
}

function NewShop({ onCancel }: { onCancel: () => void }) {
  const { completeSetup } = useCore()
  const [shopName, setShopName] = useState('')
  const [password, setPassword] = useState('')
  const [withDemo, setWithDemo] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await completeSetup({ shopName: shopName.trim() || 'My Shop', password, withDemo })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="centre">
      <form className="panel" onSubmit={(e) => void submit(e)}>
        <div className="panel-head">
          <h1>Set up ShopOS</h1>
          <p>This runs once, on this machine.</p>
        </div>
        <div className="panel-body">
          {error && <Alert>{error}</Alert>}
          <Field label="Shop name">
            <input className="input" id="shop-name" value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder="My Shop" />
          </Field>
          <Field label="Administrator password" hint="At least 6 characters. You sign in as “admin”.">
            <input className="input" id="admin-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" id="with-demo" checked={withDemo} onChange={(e) => setWithDemo(e.target.checked)} />
            Load a demo catalogue to try it out
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary lg" disabled={busy || password.length < 6}>
              {busy ? 'Setting up…' : 'Finish setup'}
            </button>
            <button type="button" className="btn ghost" onClick={onCancel}>Back</button>
          </div>
        </div>
      </form>
    </div>
  )
}

function Shell() {
  const { user, setUser, shopName, registerName } = useCore()
  /* Which set of books this window has open. Null on every machine that has
     one company, which is all of them until somebody passes `--shop`. */
  const [slot, setSlot] = useState<AppVersion | null>(null)
  useEffect(() => { void appVersion().then(setSlot) }, [])
  const pages = Permissions.visiblePages(user!.permissions)
  const [changingPassword, setChangingPassword] = useState(false)
  const [current, setCurrent] = useState<Page>(
    NAV_GROUPS.flatMap((g) => g.pages).find((p) => pages.includes(p)) ?? pages[0] ?? 'dashboard',
  )
  const initials = (user!.fullName ?? user!.username).slice(0, 2).toUpperCase()

  /* Selling an old bill again is asked for from the bills screen and happens at
     the counter, so the shell is what moves between them. The billing tabs claim
     the request themselves once they are there. */
  const canBill = pages.includes('billing')
  useEffect(() => onRepeat(() => { if (canBill) setCurrent('billing') }), [canBill])

  /* Settings lists the setup screens that are no longer in the sidebar. The
     check is here rather than there because the shell is what knows which
     pages this person's role was granted. */
  useEffect(() => onGoTo((page) => { if (pages.includes(page)) setCurrent(page) }), [pages])

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BrandMark /></div>
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">{shopName}</div>
            <div className="brand-sub">
              {registerName || 'No counter'}
              {/* Two companies on one machine are two identical windows. The
                  shop's own name above usually tells them apart; this is for
                  when it does not, and for whoever is reading it down a phone
                  line. Absent entirely on a one-company machine. */}
              {slot?.shop != null && <> · {shopLine(slot)}</>}
            </div>
          </div>
        </div>

        <nav className="nav">
          {NAV_GROUPS.map((group) => {
            const visible = group.pages
              .filter((p) => pages.includes(p))
              .filter((p) => p !== 'formats' || !pages.includes('settings'))
            if (visible.length === 0) return null
            return (
              <div key={group.label}>
                <div className="nav-group">{group.label}</div>
                {visible.map((page) => (
                  <button key={page} onClick={() => setCurrent(page)} aria-current={page === current ? 'page' : undefined}>
                    {ICONS[page]}
                    <span>{PAGE_TITLES[page] ?? page}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </nav>

        <UpdateLine />
        <div className="sidebar-foot">
          <div className="avatar">{initials}</div>
          <div style={{ minWidth: 0 }}>
            <div className="who">{user!.fullName ?? user!.username}</div>
            <div className="role">{user!.roleName}</div>
            {/* The unlock belongs to a person, not to the machine, so it does
                not outlive their session. */}
            <button className="link-btn" onClick={() => { lock(); setUser(null) }}>Sign out</button>
            {/* Not on Settings, which is behind the owner's gate: this is the
                one thing there that a cashier needs and an owner should not be
                asked for. A password somebody else chose for you is not one. */}
            <button className="link-btn" onClick={() => setChangingPassword(true)}>
              Change my password
            </button>
          </div>
        </div>
      </aside>

      {changingPassword && <ChangePassword onClose={() => setChangingPassword(false)} />}

      <main className="main">
        <div className="topbar">
          <h1>{PAGE_TITLES[current] ?? current}</h1>
          {current === 'billing' && (
            <span className="meta">Scan or type, then <span className="kbd">Enter</span> to add</span>
          )}
          <div className="spacer" />
          {/* On every screen, because the backup that failed did so at 02:00
              with nobody watching, and Settings is not a screen anyone opens
              unprompted. It stays until a backup succeeds. */}
          <BackupDot />
        </div>
        {/* On every screen, not on Settings alone: the till that cannot record
            who it is also stops running its backup and prints somewhere else,
            and nobody goes to Settings to find that out. */}
        <DeviceTroubleBanner />
        <OutOfDateBanner />
        {/* Also on every screen, and for the same reason turned around: the
            person who has to say yes is standing at this till looking at the
            counter, while the person adding one is at the other machine. A
            prompt behind Settings is a prompt nobody is there to answer. */}
        <JoinRequestPrompt />
        <div className={current === 'billing' ? 'content flush' : 'content'}>
          {/* Inside `main`, not around the shell: a page that throws must not
              take the sidebar with it, or there is no way back to the counter
              except closing the app mid-sale. */}
          <PageErrorBoundary resetKey={current}>
            <PageBody page={current} settingsToo={pages.includes('settings')} />
          </PageErrorBoundary>
        </div>
      </main>
    </div>
  )
}

function PageBody({ page, settingsToo }: { page: Page; settingsToo: boolean }) {
  switch (page) {
    /* The two that mint numbers against a counter, and so are the two that a
       till which does not know its counter must not reach. `CounterGate` says
       why. */
    case 'billing': return <CounterGate><Billing /></CounterGate>
    case 'bills': return <Bills />
    case 'dashboard': return <Dashboard />
    case 'inventory': return <Inventory />
    case 'stock_in': return <StockIn />
    case 'stock_count': return <StockCount />
    case 'reorder': return <Reorder />
    case 'credit': return <Credit />
    case 'cash_counter': return <CounterGate><CashCounter /></CounterGate>
    /* The two screens that can change what every other screen does. Staff is
       deliberately not among them: resetting a cashier's forgotten password is a
       daily job, and a second password in front of it is how an owner ends up
       turning the whole gate off. */
    case 'formats': return (
      /* Behind the same gate as Settings: this screen decides what every bill
         printed from now on looks like, which is not a thing for whoever was
         left at the counter. */
      <AdminGate scope="formats" title="Bill Formats">
        {/* Inside Settings for anyone who can open it, so there is one place
            a bill's look is decided; on its own for a role that has only this. */}
        {settingsToo ? <Settings initial="format" /> : <Formats />}
      </AdminGate>
    )
    case 'settings': return (
      <AdminGate scope="settings" title="Settings"><Settings /></AdminGate>
    )
    case 'roles': return (
      <AdminGate scope="roles" title="Roles & Permissions"><Roles /></AdminGate>
    )
    case 'customers': return <Customers />
    case 'pricing': return <Pricing />
    case 'orders': return <Orders />
    case 'purchase_orders': return <PurchaseOrders />
    case 'registers': return <Registers />
    case 'reports': return <Reports />
    case 'audit': return <Audit />
    case 'users': return <Staff />
    case 'suppliers': return <Suppliers />
    default:
      return <Empty>{PAGE_TITLES[page] ?? page} is not built yet.</Empty>
  }
}
