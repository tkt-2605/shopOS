import type {
  SqlDriver, TaxScheme, SessionUser, Features, FeatureKey, StockPolicy, ShopProfile, Rounding,
  JoinProgress,
} from '@shopos/core'
import type { StartupFailureKind } from './startup'
import type { BackupResult } from './backup'

/*
 * What every screen is handed by `CoreProvider`: the database, where startup
 * got to, who is signed in, and the shop-wide choices the counter and the
 * services have to agree on.
 */

export type Status =
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

export interface CoreValue {
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
  backup: BackupResult | null
  reloadRegister: () => Promise<void>
  setUser: (user: SessionUser | null) => void
  /** Creates the shop and returns its recovery code, which the setup screen shows before `enterShop`. */
  completeSetup: (input: { shopName: string; password: string; withDemo: boolean }) => Promise<{ recoveryCode: string }>
  /** Leaves the setup screen for the sign-in one, once the recovery code has been seen. */
  enterShop: () => void
  /**
   * Joins a shop that already exists on another till.
   *
   * The other half of `completeSetup`, and the important thing about it is what
   * it does *not* do: it never calls `bootstrap`. A machine that sets itself up
   * has created a second shop -- its own Admin role, its own counter, its own
   * default price list, all under the same names as the first shop's and none
   * of them the same row -- and no merge rule reconciles that. The handshake
   * refuses such a pair with `DIFFERENT_SHOP`, which is correct and arrives too
   * late to be any use to anybody.
   *
   * So a joining till stays empty and receives the shop: staff, roles,
   * counters, prices, customers, bills. It signs in afterwards with the shop's
   * own password, because the users arrived with everything else.
   */
  joinShop: (input: { address: string; code: string }) => Promise<void>
  /** Asks the other till to be let in, and waits for somebody to press Allow. */
  askToJoinShop: (address: string) => Promise<JoinProgress>
  waitToJoinShop: (address: string, requestId: string) => Promise<JoinProgress>
}
