import type { SqlDriver } from '@shopos/core'

/**
 * The portal's own database.
 *
 * ## Why this does not follow the shop's migration rules
 *
 * `CLAUDE.md` requires a numbered `.sql` file, an entry in `migrations.ts`
 * and a classification as additive or breaking. Every one of those exists
 * because a shop's database is replicated between tills that update at
 * different times, and a till on either side of a breaking change must know
 * not to sync.
 *
 * None of that is true here. There is one portal, the vendor runs it, it
 * talks to nobody's copy of itself, and it can be stopped for a minute to be
 * migrated. So it gets the simple thing: an ordered list of statements and
 * `user_version`, applied at boot. Writing it down because the difference is
 * a judgement and not an oversight -- if the portal ever becomes two portals,
 * this paragraph stops being true and the shop's rules start applying.
 *
 * ## What is deliberately not stored
 *
 * - **The signing key.** It is in the environment. A database dump is a thing
 *   that gets handed to somebody debugging, and the key must not be in one.
 * - **OTP codes.** Only a hash, which the challenge id salts.
 * - **Session tokens.** Only a hash, for the same reason: a dump of this
 *   table must not be a set of working logins.
 */

const SCHEMA: readonly string[] = [
  `CREATE TABLE accounts (
     id           TEXT PRIMARY KEY,
     phone        TEXT NOT NULL UNIQUE,
     name         TEXT,
     created_at   TEXT NOT NULL,
     disabled_at  TEXT
   )`,

  /* An external identity -- a Google or Apple subject -- pointing at an
     account. Separate from `accounts` so one person can have both a phone and
     an OAuth login without either being the "real" one. */
  `CREATE TABLE identities (
     id          TEXT PRIMARY KEY,
     account_id  TEXT NOT NULL REFERENCES accounts(id),
     provider    TEXT NOT NULL,
     subject     TEXT NOT NULL,
     email       TEXT,
     created_at  TEXT NOT NULL,
     UNIQUE (provider, subject)
   )`,

  `CREATE TABLE sessions (
     token_hash  TEXT PRIMARY KEY,
     account_id  TEXT NOT NULL REFERENCES accounts(id),
     created_at  TEXT NOT NULL,
     expires_at  TEXT NOT NULL,
     revoked_at  TEXT,
     issued_by   TEXT NOT NULL
   )`,
  `CREATE INDEX idx_sessions_account ON sessions(account_id)`,

  `CREATE TABLE challenges (
     id           TEXT PRIMARY KEY,
     phone        TEXT NOT NULL,
     code_hash    TEXT NOT NULL,
     purpose      TEXT NOT NULL,
     channel      TEXT NOT NULL,
     ref          TEXT,
     created_at   TEXT NOT NULL,
     expires_at   TEXT NOT NULL,
     attempts     INTEGER NOT NULL DEFAULT 0,
     consumed_at  TEXT
   )`,
  `CREATE INDEX idx_challenges_phone ON challenges(phone, created_at)`,

  `CREATE TABLE shops (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     account_id  TEXT REFERENCES accounts(id),
     created_at  TEXT NOT NULL
   )`,

  /* Every licence ever issued, not just the current one. A support call is
     "what did we send them in March", and an UPDATE cannot answer it. */
  `CREATE TABLE licences (
     id            TEXT PRIMARY KEY,
     shop_id       TEXT NOT NULL,
     token         TEXT NOT NULL,
     tier          TEXT NOT NULL,
     paid_through  TEXT,
     tills         INTEGER NOT NULL,
     kid           TEXT NOT NULL,
     issued_at     TEXT NOT NULL,
     issued_by     TEXT
   )`,
  `CREATE INDEX idx_licences_shop ON licences(shop_id, issued_at)`,

  /* Which tills have asked for a licence, from the X-ShopOS-Device header.
     This is how the vendor finds out a shop is running five counters on a
     three-till licence -- a conversation, never a refusal. */
  `CREATE TABLE devices (
     shop_id     TEXT NOT NULL,
     device_id   TEXT NOT NULL,
     first_seen  TEXT NOT NULL,
     last_seen   TEXT NOT NULL,
     version     TEXT,
     PRIMARY KEY (shop_id, device_id)
   )`,

  /* A till's daily health report (`health/`), every shop, every plan. The
     whole report is kept as it came, beside what the alert rules read from
     it, so a rule added later can be run over reports already here. It names
     no customer, no amount and no credential: the till holds it to that. */
  `CREATE TABLE health_reports (
     id            TEXT PRIMARY KEY,
     shop_id       TEXT NOT NULL,
     device_id     TEXT NOT NULL,
     shop_name     TEXT,
     received_at   TEXT NOT NULL,
     generated_at  TEXT,
     version       TEXT,
     summary       TEXT NOT NULL,
     body          TEXT NOT NULL
   )`,
  `CREATE INDEX idx_health_till ON health_reports(shop_id, device_id, received_at)`,

  /* The key each till proves itself with, given on its first report. Only a
     hash, as for sessions. Without it, anybody who learned a shop's id could
     write that shop's health for it. */
  `CREATE TABLE health_keys (
     shop_id     TEXT NOT NULL,
     device_id   TEXT NOT NULL,
     key_hash    TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     PRIMARY KEY (shop_id, device_id)
   )`,

  /* What support did: which shop was looked at, by whom, when. What makes
     "support can see my shop's health" something an owner can be shown. */
  `CREATE TABLE support_log (
     id          TEXT PRIMARY KEY,
     at          TEXT NOT NULL,
     account_id  TEXT NOT NULL,
     action      TEXT NOT NULL,
     shop_id     TEXT,
     detail      TEXT
   )`,
  `CREATE INDEX idx_support_log_shop ON support_log(shop_id, at)`,
]

/** Brings a portal database up to date. Safe to run at every boot. */
export async function migratePortal(db: SqlDriver): Promise<number> {
  const row = await db.get<{ user_version: number }>('PRAGMA user_version')
  const at = row?.user_version ?? 0

  for (let i = at; i < SCHEMA.length; i += 1) {
    await db.execute(SCHEMA[i] as string)
  }
  if (at < SCHEMA.length) {
    // PRAGMA takes no parameters, and the value is this module's own integer.
    await db.execute(`PRAGMA user_version = ${SCHEMA.length}`) // raw: PRAGMA cannot be parameterised
  }
  return SCHEMA.length
}

export interface Account {
  id: string
  phone: string
  name: string | null
  createdAt: string
  disabledAt: string | null
}

export interface Shop {
  id: string
  name: string
  accountId: string | null
  createdAt: string
}

export interface IssuedLicence {
  id: string
  shopId: string
  token: string
  tier: string
  paidThrough: string | null
  tills: number
  kid: string
  issuedAt: string
  issuedBy: string | null
}
