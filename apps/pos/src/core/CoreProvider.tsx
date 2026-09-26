import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { startupStatus } from './startup'
import { logEvent } from './log'
import {
  createTauriDriver, migrate, currentVersion, SchemaTooNewError, SchemaUnversionedError, type SqlDriver,
} from '@shopos/core'
import {
  DEVICE_LOCAL_KEYS, chooseRegister, chosenRegister, deviceSetting,
  deviceStore, establishDevice, recordStranded,
} from './device'
import { MIGRATIONS, staleBuild } from './migrations'
import { settleRestore } from './restoreHold'
import { runDailyBackup, startDailyBackupTimer, type DailyResult } from './backup'
import { runStockCheck, startMaintenanceTimer } from './maintenance'
import { serveIfPaired, servingOn } from './syncHost'
import { syncFetch } from './syncFetch'
import { startSyncLoop, stopSyncLoop, runOnce, nudgeSync } from './syncLoop'
import { watchForTillsAhead } from './outOfDate'
import { nudgingDriver } from './nudgingDriver'
import { serializingDriver } from './writeLock'
import {
  isFirstRun, firstRun, seedDemoData, applyUpgrades, login, pairWith, askToJoin, pollJoin,
  resolveDeviceRegister, legacyDeviceRegister, forgetLegacyDeviceRegister, claimIfUnclaimed,
  renewClaim,
  moveSettingsToDevice, resetSyncState, witnessClock,
  loadFeatures, setFeature, FEATURES_OFF,
  loadStockPolicy, setStockPolicy, STOCK_POLICY_DEFAULT,
  loadRounding, setRounding, ROUNDING_DEFAULT,
  loadTaxScheme, setTaxScheme, taxSchemeAnswered, type TaxScheme,
  loadShopProfile,
} from '@shopos/core'
import type { SessionUser, Features, FeatureKey, StockPolicy, ShopProfile, Rounding } from '@shopos/core'
import type { CoreValue, FailureKind, Status } from './coreValue'

/* The types live in `coreValue.ts`; `FailureKind` is re-exported because the
   screens that explain a failed start have always found it here. */
export type { FailureKind } from './coreValue'

/** Until the database has been read. Never printed — the setup screen runs first. */
const NO_SHOP: ShopProfile = {
  name: 'My Shop',
  address: null, phone: null, email: null, gstin: null, stateCode: null,
  receiptFooter: null, terms: null, logo: null,
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

/* Two wrappers, innermost first.

   `serializingDriver` queues writes, because this webview has two independent
   sources of them -- the sync loop and the inbound requests Rust forwards -- on
   a connection that holds one transaction at a time. `writeLock.ts` carries the
   argument, including why billing had to be behind the same queue.

   `nudgingDriver` then tells the other tills, rather than waiting up to
   forty-five seconds for the loop to come round. It is outside, so the nudge
   fires once the write is committed and the queue is free again. */
const db = nudgingDriver(
  serializingDriver(createTauriDriver(invoke)),
  () => nudgeSync(db),
)

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

    /* The latest instant this machine has ever seen, recorded on the machine
       rather than in the shop's database — replicating it would let the till
       with the furthest-wrong clock poison every other till's idea of the time.
       Here rather than later because a start is exactly the moment worth
       witnessing, and it touches no table, so it does not wait on `migrate`.
       Never throws: a machine that cannot record the date still sells. */
    await witnessClock(deviceStore())

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
    /* A till restored from its own backup, taking up where it left off. After
       the migrations, because a backup can be older than this build. */
    await settleRestore(db)
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
  const { stranded } = await moveSettingsToDevice(db, DEVICE_LOCAL_KEYS, deviceStore())
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
    let stopMaintenance: (() => void) | null = null
    /* Before anything can talk to another till, so the first hello from a
       newer one is written down. */
    const stopWatching = watchForTillsAhead()

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

        /* A shop that has a second till answers it, without anybody having
           pressed anything. Also picks the port back up after a webview reload:
           the port is held by Rust and the subscription by the webview, and a
           reload ends one without ending the other, which leaves a till
           listening with nobody behind it. */
        void serveIfPaired(db).catch(() => undefined)

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

        /* The weekly stock replay, on the same two o'clock and behind the same
           reasoning: too slow to do on a screen, and useless if it only runs on
           machines that are left switched on overnight. It checks every night
           and does nothing on six of them, so a till that was off last Sunday
           gets its turn on Monday rather than waiting another week. */
        void runStockCheck(db)
        stopMaintenance = startMaintenanceTimer(db, () => {})
      } catch (err) {
        if (!cancelled) setStatus({ phase: 'failed', error: describe(err), kind: kindOf(err) })
      }
    })()

    return () => {
      cancelled = true
      stopSyncLoop()
      stopBackupTimer?.()
      stopMaintenance?.()
      stopWatching()
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

    /* A till that is billing on a counter says so, even if nobody ever asked it
       which one -- a shop that has run on one machine for a year has never been
       asked, and its counter would otherwise be offered to the second till as
       free on the day it arrives. Only takes one nobody has spoken for. */
    if (id !== null) {
      await claimIfUnclaimed(db, id)
      /* And says so again every start, which is what turns the claim from a
         lock with no expiry into a statement with a date on it. A counter whose
         holder has stopped starting up can then be offered to the machine in
         front of the shopkeeper, by name and by date, instead of being refused
         for ever. Migration 045 carries the argument. */
      await renewClaim(db, id)
    }

    setRegisterId(id ?? '')
    const row = id ? await db.get<{ name: string }>(`SELECT name FROM registers WHERE id = ?`, [id]) : undefined
    setRegisterName(row?.name ?? '')
  }

  function urlOf(address: string): string {
    const bare = address.trim().replace(/\/+$/, '')
    return bare.startsWith('http') ? bare : `http://${bare}`
  }

  /* Where to call back. A till that is not listening yet sends nothing and is
     recorded when it first makes a signed request instead -- but if it is
     listening, saying so now is the difference between the other till being
     able to start a round and only ever answering one. */
  async function mineToGiveOut() {
    return { listenPort: (await servingOn())?.port ?? null }
  }

  /** Knocking. Nothing is granted here; the other till's shopkeeper decides. */
  async function askToJoinShop(address: string) {
    return await askToJoin(urlOf(address), null, syncFetch, await mineToGiveOut())
  }

  /** "May I yet?" — and, once allowed, the shop arrives. */
  async function waitToJoinShop(address: string, requestId: string) {
    const answer = await pollJoin(db, urlOf(address), requestId, syncFetch, await mineToGiveOut())
    if (answer.state === 'ALLOWED') await theShopHasArrived()
    return answer
  }

  /** The bottom rung: a code read off the other till, for a network that
   *  answers no shouts. `pairWith` settles it in one request. */
  async function joinShop(input: { address: string; code: string }) {
    await pairWith(db, urlOf(input.address), input.code.trim(), null, syncFetch, await mineToGiveOut())
    await theShopHasArrived()
  }

  async function theShopHasArrived() {
    /* Everything, in batches, through the loop the app already runs rather than
       a second path that could differ from it. `force` because the loop's own
       backoff has no opinion yet about a peer it has never met. */
    await runOnce(db, true)

    await loadRegister()
    await applyAppearance()
    setFeatures(await loadFeatures(db))
    setPolicy(await loadStockPolicy(db))
    setRound(await loadRounding(db))
    await refreshScheme()
    startSyncLoop(db)
    /* Not `ready` yet. That swaps the join screen for the sign-in one, and the
       join screen still has to ask which counter this machine is -- skipped,
       the machine falls back to the other till's counter and both mint the
       same invoice numbers. The join screen reloads once that is answered. */
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
      joinShop, askToJoinShop, waitToJoinShop,
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
