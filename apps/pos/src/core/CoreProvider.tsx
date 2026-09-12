import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createTauriDriver, migrate, type SqlDriver } from '@shopos/core'
import { MIGRATIONS } from './migrations'
import { runDailyBackup } from './backup'
import { isFirstRun, firstRun, seedDemoData, applyUpgrades, login, getSetting, getDeviceRegister } from '@shopos/core'
import type { SessionUser } from '@shopos/core'

type Status =
  | { phase: 'starting' }
  | { phase: 'setup' }
  | { phase: 'ready' }
  | { phase: 'failed'; error: string }

interface CoreValue {
  db: SqlDriver
  status: Status
  user: SessionUser | null
  registerId: string
  registerName: string
  shopName: string
  reloadRegister: () => Promise<void>
  setUser: (user: SessionUser | null) => void
  completeSetup: (input: { shopName: string; password: string; withDemo: boolean }) => Promise<void>
}

const Ctx = createContext<CoreValue | null>(null)

export function useCore(): CoreValue {
  const value = useContext(Ctx)
  if (!value) throw new Error('useCore must be used inside CoreProvider')
  return value
}

export function useDb(): SqlDriver {
  return useCore().db
}

export function useUser(): SessionUser {
  const { user } = useCore()
  if (!user) throw new Error('no signed-in user')
  return user
}

const db = createTauriDriver(invoke)

/**
 * Migration must run exactly once per process. StrictMode invokes effects twice in
 * development, and a second concurrent `migrate` collides with the transaction the
 * first one has open — so the guard is a shared promise, not a flag inside the
 * effect, which would still let both calls start.
 */
let startup: Promise<{ needsSetup: boolean }> | null = null

function startOnce(): Promise<{ needsSetup: boolean }> {
  startup ??= (async () => {
    // A reload mid-save leaves the Rust side holding a transaction no one owns
    // any more; without this the next start fails with "a transaction is already
    // open" and offers no way out.
    await invoke('sql_abandon_tx').catch(() => undefined)
    await migrate(db, MIGRATIONS)
    const needsSetup = await isFirstRun(db)
    // A shop that upgrades into a new screen should find it there, without the
    // owner's own permission choices being reset to make room for it.
    if (!needsSetup) await applyUpgrades(db)
    return { needsSetup }
  })()
  return startup
}

export function CoreProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>({ phase: 'starting' })
  const [user, setUser] = useState<SessionUser | null>(null)
  const [registerId, setRegisterId] = useState('')
  const [shopName, setShopName] = useState('ShopOS')
  const [registerName, setRegisterName] = useState('')

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const { needsSetup } = await startOnce()
        if (cancelled) return

        if (needsSetup) {
          setStatus({ phase: 'setup' })
          return
        }

        await loadRegister()
        await applyAppearance()
        await devAutoLogin()
        if (!cancelled) setStatus({ phase: 'ready' })

        // After the counter is usable, never in front of it. A shop opening for
        // the day waits for nothing, and a backup that fails is reported on the
        // Settings screen rather than blocking the till.
        void runDailyBackup(db)
      } catch (err) {
        if (!cancelled) setStatus({ phase: 'failed', error: describe(err) })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Skips the sign-in screen while developing. Gated on import.meta.env.DEV, which
   * is statically false in a production build, so this branch is removed from the
   * shipped bundle entirely — and it still requires the env var to be set.
   */
  async function devAutoLogin() {
    if (!import.meta.env.DEV) return
    const credentials = import.meta.env['VITE_DEV_LOGIN']
    if (typeof credentials !== 'string' || !credentials.includes(':')) return

    const [username, ...rest] = credentials.split(':')
    const result = await login(db, { username: username!, password: rest.join(':') })
    if (result.ok) setUser(result.user)
  }

  /** Theme and density are settings, so a shop can be re-skinned without a build. */
  async function applyAppearance() {
    const theme = (await getSetting(db, 'ui_theme')) ?? 'daylight'
    const density = (await getSetting(db, 'ui_density')) ?? 'compact'
    document.documentElement.dataset['theme'] = theme
    document.documentElement.dataset['density'] = density
    setShopName((await getSetting(db, 'shop_name')) ?? 'ShopOS')
  }

  async function loadRegister() {
    const id = await getDeviceRegister(db)
    setRegisterId(id ?? '')
    const row = id ? await db.get<{ name: string }>(`SELECT name FROM registers WHERE id = ?`, [id]) : undefined
    setRegisterName(row?.name ?? '')
  }

  async function completeSetup(input: { shopName: string; password: string; withDemo: boolean }) {
    const { adminId } = await firstRun(db, { shopName: input.shopName, adminPassword: input.password })
    if (input.withDemo) await seedDemoData(db, adminId)
    await loadRegister()
    await applyAppearance()
    setStatus({ phase: 'ready' })
  }

  return (
    <Ctx.Provider value={{ db, status, user, registerId, registerName, shopName, reloadRegister: loadRegister, setUser, completeSetup }}>
      {children}
    </Ctx.Provider>
  )
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
