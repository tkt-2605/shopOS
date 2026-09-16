import type { SqlDriver, SqlValue } from '../db/driver.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { getSetting, setSetting } from './bootstrap.js'
import { isStateCode } from '../domain/states.js'
import { GSTIN_SHAPE, stateFromGstin } from '../domain/gstin.js'

/* Re-exported because the screens have imported them from here since v1 and
   the rules themselves are now shared with the customer path. */
export { STATES, stateName } from '../domain/states.js'

/**
 * Who the shop is, on paper.
 *
 * Every field here was already being read somewhere before this file existed and
 * written nowhere. `core/print.ts` has asked for the address, the phone and the
 * GSTIN on every receipt since v1; `core/pdf.ts` asks for the same on every
 * statement; `services/billing.ts` asks for the state code on every single bill.
 * All four came back null, for ever, because the only screen that could have set
 * them showed the signed-in user's name and nothing else.
 *
 * The state code is the serious one. `supplyTypeFor(null, anything)` answers
 * `intra_state`, so with no shop state every sale in the product has been taxed
 * as a local sale — CGST and SGST — including sales to a customer in another
 * state, where the law says IGST. That is wrong tax on a real invoice, and it is
 * wrong quietly, which is the worst way for tax to be wrong.
 *
 * One service rather than nine `setSetting` calls out of a form, because two of
 * these fields have to agree with each other: the first two characters of a
 * GSTIN *are* the state code. A shop that picks Kerala and pastes a Tamil Nadu
 * GSTIN has made a mistake that is cheap to catch here and expensive to find on
 * a filing.
 */

export interface ShopProfile {
  name: string
  address: string | null
  phone: string | null
  email: string | null
  gstin: string | null
  /** Two digits, the GST state code. Decides CGST/SGST against IGST. */
  stateCode: string | null
  /** The small print at the bottom of a receipt. */
  receiptFooter: string | null
  /** Terms and conditions, for the documents with room for them. */
  terms: string | null
  /**
   * The shop's mark, as a `data:` URI — the image itself, not a path to it.
   *
   * Kept inline because a bill has to print from the app window, from a browser
   * tab in development, and from a preview that is only ever HTML. None of the
   * three can be handed a filename and asked to go and read it, and a logo that
   * printed in one of them and not the others would be worse than none.
   */
  logo: string | null
}

/** The key each field is stored under. Adding a field is one line here. */
const SETTING: Record<keyof ShopProfile, string> = {
  name: 'shop_name',
  address: 'shop_address',
  phone: 'shop_phone',
  email: 'shop_email',
  gstin: 'shop_gstin',
  stateCode: 'shop_state_code',
  receiptFooter: 'receipt_footer',
  terms: 'shop_terms',
  logo: 'shop_logo',
}

const FIELDS = Object.keys(SETTING) as (keyof ShopProfile)[]

export type SaveShopResult =
  | { ok: true }
  | { ok: false; code: 'NAME_REQUIRED' }
  | { ok: false; code: 'BAD_GSTIN' }
  | { ok: false; code: 'UNKNOWN_STATE' }
  | { ok: false; code: 'GSTIN_STATE_MISMATCH'; gstinState: string; chosenState: string }
  | { ok: false; code: 'BAD_LOGO' }
  | { ok: false; code: 'LOGO_TOO_BIG'; kb: number; limitKb: number }

export async function loadShopProfile(db: SqlDriver): Promise<ShopProfile> {
  const values = await Promise.all(FIELDS.map((field) => getSetting(db, SETTING[field])))

  const profile = Object.fromEntries(
    FIELDS.map((field, i) => [field, blankToNull(values[i])]),
  ) as unknown as ShopProfile

  // The name is the one field that cannot be absent — it is on every document,
  // and `bootstrap` has always written it. A database old enough or odd enough
  // to have lost it gets the same words the setup screen suggests.
  return { ...profile, name: profile.name ?? 'My Shop' }
}

/**
 * Audited, because "the GSTIN on our invoices changed and nobody touched it" has
 * to have an answer, and because this is the screen behind the password gate.
 */
export async function saveShopProfile(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  next: ShopProfile,
): Promise<SaveShopResult> {
  const clean: ShopProfile = {
    name: next.name.trim(),
    address: tidy(next.address),
    phone: tidy(next.phone),
    email: tidy(next.email),
    gstin: tidy(next.gstin)?.toUpperCase() ?? null,
    stateCode: tidy(next.stateCode),
    receiptFooter: tidy(next.receiptFooter),
    terms: tidy(next.terms),
    logo: tidy(next.logo),
  }

  if (clean.name === '') return { ok: false, code: 'NAME_REQUIRED' }

  if (clean.logo !== null) {
    if (!LOGO_SHAPE.test(clean.logo)) return { ok: false, code: 'BAD_LOGO' }
    /* It rides on every bill this shop ever prints and on every preview, so it
       is capped where a mark still looks right and a photograph does not fit.
       Base64 carries three bytes in four characters. */
    const kb = Math.round((clean.logo.length * 3) / 4 / 1024)
    if (kb > LOGO_LIMIT_KB) return { ok: false, code: 'LOGO_TOO_BIG', kb, limitKb: LOGO_LIMIT_KB }
  }
  if (clean.gstin !== null && !GSTIN_SHAPE.test(clean.gstin)) return { ok: false, code: 'BAD_GSTIN' }
  if (clean.stateCode !== null && !isStateCode(clean.stateCode)) {
    return { ok: false, code: 'UNKNOWN_STATE' }
  }

  /* The two fields that must agree. Caught here rather than at filing time,
     where it is a correction rather than a typo. */
  const gstinState = stateFromGstin(clean.gstin)
  if (gstinState !== null && clean.stateCode !== null && gstinState !== clean.stateCode) {
    return {
      ok: false,
      code: 'GSTIN_STATE_MISMATCH',
      gstinState,
      chosenState: clean.stateCode,
    }
  }

  const before = await loadShopProfile(db)
  const now = ctx.now?.() ?? new Date().toISOString()

  await db.transaction(async (tx) => {
    for (const field of FIELDS) {
      const value = clean[field]
      if (value === before[field]) continue
      await setSetting(tx, SETTING[field], value ?? '', now)
    }

    // Only what moved, so the history reads as a change rather than as a dump
    // of every field the form happened to contain.
    await writeAudit(tx, ctx, {
      entity: 'settings',
      entityId: 'shop_profile',
      action: 'update',
      before: auditable(before, clean),
      after: auditable(clean, before),
    })
  })

  return { ok: true }
}

/**
 * The fields that differ, as audit values.
 *
 * The logo is named but never carried: it is tens of kilobytes of base64, and
 * a history row that held two copies of it would be unreadable and would grow
 * the database every time somebody tried a new one. That it changed is the
 * news; the image is on the screen.
 */
function auditable(from: ShopProfile, against: ShopProfile): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {}
  for (const field of FIELDS) {
    if (from[field] === against[field]) continue
    out[field] = field === 'logo' ? (from[field] === null ? 'none' : 'an image') : from[field]
  }
  return out
}

/** Only what the sheet will actually put in an `src`. */
const LOGO_SHAPE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/
const LOGO_LIMIT_KB = 256

/** A form sends '' for a field a person emptied; the database should hold null. */
function tidy(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

function blankToNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value
}
