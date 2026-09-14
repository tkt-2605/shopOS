import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createTauriDriver, migrate, type SqlDriver } from '@shopos/core'
import {
  DEVICE_LOCAL_KEYS, chooseRegister, chosenRegister, deviceSetting,
  establishDevice, setDeviceSetting,
} from './device'
import { MIGRATIONS, staleBuild } from './migrations'
import { runDailyBackup } from './backup'
import {
  isFirstRun, firstRun, seedDemoData, applyUpgrades, login,
  resolveDeviceRegister, takeLegacyDeviceRegister, takeLocalSetting,
  loadFeatures, setFeature, FEATURES_OFF,
  loadStockPolicy, setStockPolicy, STOCK_POLICY_DEFAULT,
  loadRounding, setRounding, ROUNDING_DEFAULT,
  loadShopProfile,
} from '@shopos/core'
import type {
  SessionUser, Features, FeatureKey, StockPolicy, ShopProfile, Rounding,
} from '@shopos/core'

/** Until the database has been read. Never printed — the setup screen runs first. */
const NO_SHOP: ShopProfile = {
  name: 'My Shop',
  address: null, phone: null, email: null, gstin: null, stateCode: null,
  receiptFooter: null, terms: null, logo: null,
}

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
  /**
   * Who the shop is, on paper. Held here rather than read per screen so that
   * saving a new name or address changes the sidebar and the next receipt at the
   * same moment — a shop that corrects its GSTIN and then prints the old one
   * until it restarts would have no way of knowing the save worked.
   */
  shop: ShopProfile
  refreshShop: () => Promise<void>
  /** `shop.name`, kept for the places that only ever wanted the name. */
  shopName: string
  /**
   * Which optional capabilities this shop uses. Held here rather than read on
   * every screen so that switching one off takes effect everywhere at once —
   * the product form, the prices screen and the counter cannot disagree about
   * whether the shop has quantity breaks.
   */
  features: Features
  setFeatureFlag: (key: FeatureKey, on: boolean) => Promise<void>
  /** What the counter does when the count says there is nothing left. */
  stockPolicy: StockPolicy
  /**
   * What the counter does with the last few paise.
   *
   * In context rather than read per screen because the cart computes its own
   * totals as the cashier works — the service reads the same setting when it
   * writes the bill, and the two have to agree to the paisa or the counter
   * shows one figure and charges another.
   */
  rounding: Rounding
  setRoundingTo: (rule: Rounding) => Promise<void>
  setStockPolicyTo: (policy: StockPolicy) => Promise<void>
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

    /* Before anything reads a table: this bundle's .sql files were fixed when it
       was built, and the code around them was not. Starting against a database
       the code is ahead of fails one query at a time, on whichever screen asks
       first, with nothing to connect it to the cause. */
    const stale = staleBuild()
    if (stale) throw new Error(stale)

    /* Before the first row of the session is written, not after. Everything
       below this line — the upgrade pass, the first sign-in, the first bill —
       records who did it and on which machine, and a device established late
       would leave a hole at the start of every session that nothing can fill
       in afterwards. */
    await establishDevice()

    await migrate(db, MIGRATIONS)
    await adoptDeviceSettings(db)
    const needsSetup = await isFirstRun(db)
    // A shop that upgrades into a new screen should find it there, without the
    // owner's own permission choices being reset to make room for it.
    if (!needsSetup) await applyUpgrades(db)
    return { needsSetup }
  })()
  return startup
}

/**
 * Moves the settings that describe a machine out of the table that describes the
 * shop, once.
 *
 * Runs after `migrate` because it writes to `settings`, and before any screen
 * reads one, so nothing sees the value in two places. A key already recorded on
 * this machine is left alone: the machine's own answer outranks whatever the
 * shared row happens to say, which matters on the second till to be upgraded.
 */
async function adoptDeviceSettings(db: SqlDriver): Promise<void> {
  for (const key of DEVICE_LOCAL_KEYS) {
    const shared = await takeLocalSetting(db, key)
    if (shared !== null && deviceSetting(key) === null) {
      await setDeviceSetting(key, shared)
    }
  }
}

export function CoreProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>({ phase: 'starting' })
  const [user, setUser] = useState<SessionUser | null>(null)
  const [registerId, setRegisterId] = useState('')
  const [shop, setShop] = useState<ShopProfile>(NO_SHOP)
  const [registerName, setRegisterName] = useState('')
  const [features, setFeatures] = useState<Features>(FEATURES_OFF)
  const [stockPolicy, setPolicy] = useState<StockPolicy>(STOCK_POLICY_DEFAULT)
  const [rounding, setRound] = useState<Rounding>(ROUNDING_DEFAULT)

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
        setFeatures(await loadFeatures(db))
        setPolicy(await loadStockPolicy(db))
        setRound(await loadRounding(db))
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
    // How this screen is set up is a fact about this screen: a 10-inch till at
    // the counter and the owner's laptop want different answers.
    const theme = deviceSetting('ui_theme') ?? 'daylight'
    const density = deviceSetting('ui_density') ?? 'compact'
    document.documentElement.dataset['theme'] = theme
    document.documentElement.dataset['density'] = density
    await refreshShop()
  }

  async function refreshShop() {
    const profile = await loadShopProfile(db)
    setShop(profile)
    /* The shop in front of the product, both on paper and on the taskbar. The
       window is still ShopOS — that is what the person is running — but which
       shop it is open on is the thing an owner with two of them needs to see. */
    document.title = `${profile.name} — ShopOS`
  }

  async function setFeatureFlag(key: FeatureKey, on: boolean) {
    if (!user) return
    await setFeature(db, { actorId: user.id }, key, on)
    setFeatures(await loadFeatures(db))
  }

  async function setStockPolicyTo(policy: StockPolicy) {
    if (!user) return
    await setStockPolicy(db, { actorId: user.id }, policy)
    setPolicy(await loadStockPolicy(db))
  }

  async function setRoundingTo(rule: Rounding) {
    if (!user) return
    await setRounding(db, { actorId: user.id }, rule)
    setRound(await loadRounding(db))
  }

  async function loadRegister() {
    /* Which counter this machine is used to be a row in `settings`, which the
       whole shop shares — so two tills would have claimed the same counter and
       minted the same invoice numbers. It lives on the machine now. A shop
       already running still has the old row, and on a single till it holds the
       right answer, so it is moved across once and then removed. */
    if (chosenRegister() === null) {
      const legacy = await takeLegacyDeviceRegister(db)
      if (legacy !== null) await chooseRegister(legacy)
    }

    const id = await resolveDeviceRegister(db, chosenRegister())
    setRegisterId(id ?? '')
    const row = id ? await db.get<{ name: string }>(`SELECT name FROM registers WHERE id = ?`, [id]) : undefined
    setRegisterName(row?.name ?? '')
  }

  async function completeSetup(input: { shopName: string; password: string; withDemo: boolean }) {
    const { adminId } = await firstRun(db, { shopName: input.shopName, adminPassword: input.password })
    if (input.withDemo) await seedDemoData(db, adminId)
    await loadRegister()
    await applyAppearance()
    setFeatures(await loadFeatures(db))
    setPolicy(await loadStockPolicy(db))
    setRound(await loadRounding(db))
    setStatus({ phase: 'ready' })
  }

  return (
    <Ctx.Provider value={{
      db, status, user, registerId, registerName,
      shop, refreshShop, shopName: shop.name,
      features, stockPolicy, rounding,
      setFeatureFlag, setStockPolicyTo, setRoundingTo,
      reloadRegister: loadRegister, setUser, completeSetup,
    }}>
      {children}
    </Ctx.Provider>
  )
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
