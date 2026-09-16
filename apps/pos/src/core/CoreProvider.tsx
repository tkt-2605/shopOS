import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { startupStatus, type StartupFailureKind } from './startup'
import { logEvent } from './log'
import {
  createTauriDriver, migrate, currentVersion, SchemaTooNewError, SchemaUnversionedError, type SqlDriver,
} from '@shopos/core'
import {
  DEVICE_LOCAL_KEYS, chooseRegister, chosenRegister, deviceSetting,
  establishDevice, recordStranded, setDeviceSetting,
} from './device'
import { MIGRATIONS, staleBuild } from './migrations'
import { runDailyBackup, startDailyBackupTimer, type DailyResult } from './backup'
import { resumeServing } from './syncHost'
import { startSyncLoop, stopSyncLoop } from './syncLoop'
import {
  isFirstRun, firstRun, seedDemoData, applyUpgrades, login,
  resolveDeviceRegister, legacyDeviceRegister, forgetLegacyDeviceRegister,
  moveSettingsToDevice, resetSyncState,
  loadFeatures, setFeature, FEATURES_OFF,
  loadStockPolicy, setStockPolicy, STOCK_POLICY_DEFAULT,
  loadRounding, setRounding, ROUNDING_DEFAULT,
  loadTaxScheme, setTaxScheme, taxSchemeAnswered, type TaxScheme,
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
  /**
   * `kind` so the screen can offer the right way out, not only the right words.
   *
   * A database written by a newer build and a database that is damaged both
   * stop the till, and the two want opposite advice: one wants this machine
   * updated, and the other wants a backup restored. Offering "Restore a
   * backup…" first to a shop whose till is merely behind invites them to
   * overwrite a newer database with an older copy, which is how a day's billing
   * is lost while following the instructions on the screen.
   */
  | { phase: 'failed'; error: string; kind: FailureKind }

/**
 * Every way the till can fail to open, from both sides of the bridge.
 *
 * The first three are Rust's, decided from SQLite's own error codes before the
 * webview has asked the database anything. The next two are the webview's,
 * raised by the migration runner. They are one union because `CouldNotStart` has
 * to give one answer, and the answers are opposites: a till that is merely
 * behind must not be offered a Restore button, and a till with a damaged file
 * must not be told to go and update itself.
 */
export type FailureKind =
  | StartupFailureKind
  | 'schema_too_new'
  | 'schema_unversioned'
  | 'other'

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
  /**
   * Which GST scheme the shop is under, and whether a person has ever said.
   *
   * In context for the same reason as `rounding`: the cart works out its own
   * totals as the cashier types, the service works them out again when it
   * writes the bill, and a screen that thought the shop charged tax while the
   * service thought it did not would show one figure and charge another.
   *
   * `taxSchemeAsked` is false until somebody answers. Until then the till is
   * deriving the scheme from whether a GSTIN is set, which is a guess -- a good
   * one, and still a guess about whether this shop may collect tax.
   */
  taxScheme: TaxScheme
  taxSchemeAsked: boolean
  setTaxSchemeTo: (scheme: TaxScheme) => Promise<void>
  /**
   * How the last automatic backup went, or null before the first one has run.
   *
   * Held here rather than fetched by the Settings screen because the screen is
   * not open when it happens — the backup runs at startup and again at 02:00,
   * and its failure used to be returned to a `void` call and dropped. A shop
   * whose backup folder had gone read-only found out when it needed the backup.
   */
  backup: DailyResult | null
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

    /* Every migration, as it commits. An upgrade is the most dangerous thing
       this program does to a shop's data and it used to happen in silence: if a
       till came back wrong after an update there was no way to tell which
       migration had run, or how far it got. */
    const before = await currentVersion(db)
    await migrate(db, MIGRATIONS, (m) => {
      logEvent('info', 'migrate', `applied ${m.version} ${m.name}`)
    })
    const after = await currentVersion(db)
    if (after !== before) logEvent('info', 'migrate', `schema ${before} -> ${after}`)

    /* Belt and braces, and cheap. `applyingRemote` only ever sets the flag
       inside a transaction, so a merge that failed rolled it back and one that
       lost power never committed it — but the cost of being wrong about that is
       a till that quietly records nothing to replicate and never says so. */
    await resetSyncState(db)

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
 * reads one, so nothing ever sees a value in two places. The order — machine
 * first, shared row second — is the part that matters, and it lives in
 * `moveSettingsToDevice` where it is tested.
 */
async function adoptDeviceSettings(db: SqlDriver): Promise<void> {
  const { stranded } = await moveSettingsToDevice(db, DEVICE_LOCAL_KEYS, {
    has: deviceSetting,
    put: setDeviceSetting,
  })
  // Left in the shared table on purpose; the next start tries again. Recorded
  // rather than only logged, because what the shopkeeper actually sees when this
  // fails is a till that printed somewhere else and stopped backing up.
  recordStranded(stranded)
  if (stranded.length > 0) {
    console.error('This machine could not take over its own settings:', stranded.join(', '))
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
  const [taxScheme, setScheme] = useState<TaxScheme>('regular')
  const [taxSchemeAsked, setSchemeAsked] = useState(true)
  const [backup, setBackup] = useState<DailyResult | null>(null)

  useEffect(() => {
    let cancelled = false
    let stopBackupTimer: (() => void) | null = null

    void (async () => {
      try {
        /* Before the driver and before the migrations, because both would fail
           with something less true. A file that is not a database produces a
           SQL error about a missing `settings` table, and the shop reads that
           and starts wondering what it did to its settings. */
        const refused = await startupStatus()
        if (cancelled) return
        if (refused) {
          setStatus({ phase: 'failed', error: refused.message, kind: refused.kind })
          return
        }

        const { needsSetup } = await startOnce()
        if (cancelled) return

        if (needsSetup) {
          setStatus({ phase: 'setup' })
          return
        }

        await loadRegister()
        await applyAppearance()

        /* The port is held by Rust and the subscription by the webview, and a
           reload ends one without ending the other. Left alone that is a till
           listening with nobody behind it. */
        void resumeServing(db).catch(() => undefined)

        /* Catching up on its own, because nobody presses a button every ninety
           seconds all day. Does nothing at all until a shop has paired, which
           is most shops. */
        startSyncLoop(db)
        setFeatures(await loadFeatures(db))
        setPolicy(await loadStockPolicy(db))
        setRound(await loadRounding(db))
        await refreshScheme()
        await devAutoLogin()
        if (!cancelled) setStatus({ phase: 'ready' })

        // After the counter is usable, never in front of it. A shop opening for
        // the day waits for nothing, and a backup that fails is reported on the
        // Settings screen and by a dot in the top bar rather than blocking the
        // till.
        void runDailyBackup(db).then((result) => {
          if (!cancelled) setBackup(result)
        })

        // And again at 02:00, for the machines that are never switched off.
        // `backup.ts` carries why once-per-opening was not enough on its own.
        stopBackupTimer = startDailyBackupTimer(db, (result) => {
          if (!cancelled) setBackup(result)
        })
      } catch (err) {
        if (!cancelled) setStatus({ phase: 'failed', error: describe(err), kind: kindOf(err) })
      }
    })()

    return () => {
      cancelled = true
      stopSyncLoop()
      stopBackupTimer?.()
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

  async function refreshScheme() {
    setScheme(await loadTaxScheme(db))
    setSchemeAsked(await taxSchemeAnswered(db))
  }

  async function setTaxSchemeTo(scheme: TaxScheme) {
    if (!user) return
    await setTaxScheme(db, { actorId: user.id }, scheme)
    await refreshScheme()
  }

  async function loadRegister() {
    /* Which counter this machine is used to be a row in `settings`, which the
       whole shop shares — so two tills would have claimed the same counter and
       minted the same invoice numbers. It lives on the machine now. A shop
       already running still has the old row, and on a single till it holds the
       right answer, so it is moved across once and then removed. */
    if (chosenRegister() === null) {
      const legacy = await legacyDeviceRegister(db)
      // Recorded on the machine before the shared row goes, never after: the
      // file write can fail, and a counter lost here is a till that silently
      // starts minting another till's invoice numbers.
      if (legacy !== null && await chooseRegister(legacy)) {
        await forgetLegacyDeviceRegister(db)
      }
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
    await refreshScheme()
    setStatus({ phase: 'ready' })
  }

  return (
    <Ctx.Provider value={{
      db, status, user, registerId, registerName,
      shop, refreshShop, shopName: shop.name,
      features, stockPolicy, rounding, backup,
      taxScheme, taxSchemeAsked, setTaxSchemeTo,
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

/**
 * What kind of not-starting this is.
 *
 * By class rather than by reading the message, so a reworded error does not
 * silently turn into "other" and start offering the wrong advice again.
 */
function kindOf(err: unknown): FailureKind {
  if (err instanceof SchemaTooNewError) return 'schema_too_new'
  if (err instanceof SchemaUnversionedError) return 'schema_unversioned'
  return 'other'
}
