import { useEffect, useState } from 'react'
import { login, Permissions, type Page } from '@shopos/core'
import { useCore, type FailureKind } from './core/CoreProvider'
import { Field, Alert, Empty } from './ui/components'
import { RestorePanel } from './ui/RestorePanel'
import { DeviceTroubleBanner } from './ui/DeviceTrouble'
import { PageErrorBoundary } from './ui/ErrorBoundary'
import { BackupDot } from './ui/BackupDot'
import { ChangePassword } from './ui/ChangePassword'
import { abandonRestore } from './core/restore'
import { onRepeat } from './core/repeat'
import { onGoTo } from './core/nav'
import { appVersion, versionLine, type AppVersion } from './core/version'
import { ICONS, BrandMark } from './ui/icons'
import { AdminGate } from './ui/AdminGate'
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

   Bill Formats is not one of them, though it was at first and that was wrong.
   It is not a twice-a-year screen — it is a design tool, opened over and over
   while a shop gets its bill looking right, and a design tool behind a password
   prompt inside another screen is a design tool nobody finds. */

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
 * The way out of a shop that will not open.
 *
 * Restore lives here as well as in Settings, because a database this build
 * cannot read fails before sign-in — and a fix that sits behind the screen that
 * will not load is not a fix.
 */
function CouldNotStart({ error, kind }: { error: string; kind: FailureKind }) {
  const [restoring, setRestoring] = useState(false)
  /* A till that is merely behind and a database that is damaged both land here
     and want opposite advice. Offering "Restore a backup…" first to the former
     invites somebody to overwrite a newer database with an older copy — a day's
     billing lost while following the instructions on the screen. */
  const behind = kind === 'schema_too_new'
  // The one screen where the version matters most and was hardest to get: a
  // shop that cannot start cannot open Settings to read it.
  const [version, setVersion] = useState<AppVersion | null>(null)
  useEffect(() => { void appVersion().then(setVersion) }, [])

  return (
    <div className="centre">
      <div className="panel" style={{ maxWidth: restoring ? 620 : undefined }}>
        <div className="panel-head">
          <h1>{behind ? 'This till needs updating' : 'Could not start'}</h1>
        </div>
        <div className="panel-body">
          <Alert>{error}</Alert>
          {behind && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              Nothing is wrong with the database — it was written by a newer
              ShopOS than this machine has. Update this till and it will open as
              it was.
              <br />
              <strong>Do not restore an older backup to get past this.</strong>{' '}
              It would replace what the newer version has written, and whatever
              was billed on it would be gone.
            </div>
          )}
          {!restoring && (
            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
              <button
                className={behind ? 'btn ghost' : 'btn'}
                onClick={() => setRestoring(true)}
              >
                Restore a backup…
              </button>
              <button className="btn ghost" onClick={() => { void abandonRestore().then(() => window.location.reload()) }}>
                Cancel a pending restore
              </button>
            </div>
          )}
          {restoring && (
            <div style={{ marginTop: 14 }}>
              <RestorePanel standalone />
              <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setRestoring(false)}>
                Back
              </button>
            </div>
          )}
          <div style={{ marginTop: 16, fontSize: 12, color: 'var(--ink-3)' }}>
            ShopOS {versionLine(version)}
          </div>
        </div>
      </div>
    </div>
  )
}

function Setup() {
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
          <button className="btn primary lg" disabled={busy || password.length < 6}>
            {busy ? 'Setting up…' : 'Finish setup'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Login() {
  const { db, setUser } = useCore()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const result = await login(db, { username, password })
    setBusy(false)

    if (result.ok) {
      setUser(result.user)
      return
    }
    setError(
      result.code === 'ACCOUNT_DISABLED'
        ? 'This account has been turned off.'
        : 'That username and password do not match.',
    )
  }

  return (
    <div className="centre">
      <form className="panel" onSubmit={(e) => void submit(e)}>
        <div className="panel-head">
          <h1>ShopOS</h1>
          <p>Sign in to the counter</p>
        </div>
        <div className="panel-body">
          {error && <Alert>{error}</Alert>}
          <Field label="Username">
            <input className="input" id="username" value={username} autoFocus onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="Password">
            <input className="input" id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <button className="btn primary lg" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
    </div>
  )
}

function Shell() {
  const { user, setUser, shopName, registerName } = useCore()
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
            <div className="brand-sub">{registerName || 'No counter'}</div>
          </div>
        </div>

        <nav className="nav">
          {NAV_GROUPS.map((group) => {
            const visible = group.pages.filter((p) => pages.includes(p))
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
        <div className={current === 'billing' ? 'content flush' : 'content'}>
          {/* Inside `main`, not around the shell: a page that throws must not
              take the sidebar with it, or there is no way back to the counter
              except closing the app mid-sale. */}
          <PageErrorBoundary resetKey={current}>
            <PageBody page={current} />
          </PageErrorBoundary>
        </div>
      </main>
    </div>
  )
}

function PageBody({ page }: { page: Page }) {
  switch (page) {
    case 'billing': return <Billing />
    case 'bills': return <Bills />
    case 'dashboard': return <Dashboard />
    case 'inventory': return <Inventory />
    case 'stock_in': return <StockIn />
    case 'stock_count': return <StockCount />
    case 'reorder': return <Reorder />
    case 'credit': return <Credit />
    case 'cash_counter': return <CashCounter />
    /* The two screens that can change what every other screen does. Staff is
       deliberately not among them: resetting a cashier's forgotten password is a
       daily job, and a second password in front of it is how an owner ends up
       turning the whole gate off. */
    case 'formats': return (
      /* Behind the same gate as Settings: this screen decides what every bill
         printed from now on looks like, which is not a thing for whoever was
         left at the counter. */
      <AdminGate scope="formats" title="Bill Formats"><Formats /></AdminGate>
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
