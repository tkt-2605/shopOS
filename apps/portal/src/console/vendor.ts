import { normalisePhone } from '../auth/otp.js'

/*
 * Who works for the vendor, and what each may do on the console.
 *
 * A vendor signs in exactly as an owner does -- phone and a code -- and is a
 * vendor because their phone is in `SHOPOS_VENDOR_PHONES`. There is no vendor
 * password to keep and no second sign-in to build; the list is the vendor's
 * to edit, and a second person helping with support is one more entry.
 *
 * The roles grow with the kit: `view` reads health; `support` also opens a
 * shop's data when that exists (part 4); `admin` also forgets a till's key and
 * makes repair packs (part 6).
 */

export type Role = 'view' | 'support' | 'admin'

const RANK: Record<Role, number> = { view: 0, support: 1, admin: 2 }

/** `+919876543210:admin, +919812345678:view`. A phone with no role is `view`. */
export function parseVendors(raw: string | undefined): Map<string, Role> {
  const vendors = new Map<string, Role>()
  for (const entry of (raw ?? '').split(',')) {
    const [phone, role] = entry.split(':').map((p) => p.trim())
    const normal = phone ? normalisePhone(phone) : null
    if (normal === null) continue
    vendors.set(normal, role === 'admin' || role === 'support' ? role : 'view')
  }
  return vendors
}

export function mayDo(role: Role | null, needs: Role): boolean {
  return role !== null && RANK[role] >= RANK[needs]
}
