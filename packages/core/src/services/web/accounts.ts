import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import { requirePermission } from '../../integrity/permissions.js'
import { writeAudit } from '../../integrity/audit.js'
import type { GoogleIdentity } from './google.js'

/*
 * A customer of the storefront: who Google says they are, and the name and
 * phone they gave the shop.
 *
 * The phone is only what was typed until a cashier checks it with the customer
 * in front of them. Until then it is a number to ring when an order is ready
 * and nothing more -- in particular it never links the account to a customer
 * the shop already has, whose price list and khata a stranger would otherwise
 * inherit by typing their number (`orders.ts`, `customerFor`).
 */

export interface WebAccount {
  id: string
  email: string | null
  name: string | null
  phone: string | null
  phoneVerified: boolean
  customerId: string | null
}

const columns = {
  id: schema.webAccounts.id,
  email: schema.webAccounts.email,
  name: schema.webAccounts.name,
  phone: schema.webAccounts.phone,
  phoneVerifiedAt: schema.webAccounts.phoneVerifiedAt,
  customerId: schema.webAccounts.customerId,
}

type Row = { id: string; email: string | null; name: string | null; phone: string | null; phoneVerifiedAt: string | null; customerId: string | null }

const toAccount = (r: Row): WebAccount => ({
  id: r.id, email: r.email, name: r.name, phone: r.phone, phoneVerified: r.phoneVerifiedAt !== null, customerId: r.customerId,
})

export async function loadAccount(db: SqlDriver, accountId: string): Promise<WebAccount | null> {
  const [row] = await q(db).select(columns).from(schema.webAccounts).where(eq(schema.webAccounts.id, accountId))
  return row ? toAccount(row) : null
}

/** The account for this Google identity, made the first time it signs in. */
export async function signIn(db: SqlDriver, identity: GoogleIdentity, now: Date): Promise<WebAccount> {
  const at = now.toISOString()
  const [held] = await q(db).select(columns).from(schema.webAccounts)
    .where(eq(schema.webAccounts.googleSub, identity.sub))
  if (held) {
    if (held.email !== identity.email) {
      await q(db).update(schema.webAccounts).set({ email: identity.email, updatedAt: at })
        .where(eq(schema.webAccounts.id, held.id))
    }
    return toAccount({ ...held, email: identity.email })
  }
  const id = newId()
  await q(db).insert(schema.webAccounts).values({
    id, googleSub: identity.sub, email: identity.email, name: identity.name, createdAt: at, updatedAt: at,
  }).onConflictDoNothing()
  /* Lost a race with the same person signing in on two phones at once: the
     other insert is the account. */
  const [made] = await q(db).select(columns).from(schema.webAccounts)
    .where(eq(schema.webAccounts.googleSub, identity.sub))
  return toAccount(made!)
}

/**
 * An Indian mobile number as ten digits, or null when it is not one. A leading
 * `+91`, `91` or `0` is the same number written for somebody else's phone.
 */
export function normalisePhone(input: string): string | null {
  let digits = input.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  return /^[6-9]\d{9}$/.test(digits) ? digits : null
}

export type SaveContactResult =
  | { ok: true; account: WebAccount }
  | { ok: false; code: 'NAME_REQUIRED' | 'BAD_PHONE' | 'UNKNOWN_ACCOUNT' }

/** The name and phone the customer gives the shop. A new number has to be checked again. */
export async function saveContact(
  db: SqlDriver, accountId: string, input: { name: string; phone: string }, now: Date,
): Promise<SaveContactResult> {
  const name = input.name.trim().slice(0, 80)
  if (name === '') return { ok: false, code: 'NAME_REQUIRED' }
  const phone = normalisePhone(input.phone)
  if (phone === null) return { ok: false, code: 'BAD_PHONE' }
  const held = await loadAccount(db, accountId)
  if (!held) return { ok: false, code: 'UNKNOWN_ACCOUNT' }
  const changed = held.phone !== phone
  await q(db).update(schema.webAccounts).set({
    name,
    phone,
    ...(changed ? { phoneVerifiedAt: null, phoneVerifiedBy: null } : {}),
    updatedAt: now.toISOString(),
  }).where(eq(schema.webAccounts.id, accountId))
  return { ok: true, account: (await loadAccount(db, accountId))! }
}

/**
 * A cashier has checked the phone with the customer in front of them.
 *
 * Under `customer` `write`, the permission a cashier already has to correct a
 * customer's details: this is the same act, done at the same counter.
 */
export async function verifyPhone(
  db: SqlDriver, input: { accountId: string; actorId: string; now?: Date },
): Promise<{ ok: true } | { ok: false; code: 'UNKNOWN_ACCOUNT' | 'NO_PHONE' }> {
  await requirePermission(db, input.actorId, 'customer', 'write')
  const held = await loadAccount(db, input.accountId)
  if (!held) return { ok: false, code: 'UNKNOWN_ACCOUNT' }
  if (held.phone === null) return { ok: false, code: 'NO_PHONE' }
  const at = (input.now ?? new Date()).toISOString()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.webAccounts)
      .set({ phoneVerifiedAt: at, phoneVerifiedBy: input.actorId, updatedAt: at })
      .where(eq(schema.webAccounts.id, input.accountId))
    await writeAudit(tx, { actorId: input.actorId, now: () => at }, {
      entity: 'web_accounts', entityId: input.accountId, action: 'update',
      after: { phone: held.phone, phone_verified_at: at },
    })
  })
  return { ok: true }
}
