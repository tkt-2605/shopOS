import type { SqlDriver } from '../db/driver.js'

/**
 * Permissions and page visibility come from the same tables, so a page the owner
 * hides is also a route the user cannot reach and a service call they cannot make.
 * Nothing here is hardcoded — the shop owner configures their own staff.
 */

export const RESOURCES = [
  'bill', 'sales_return', 'payment', 'stock_entry', 'product', 'customer',
  'supplier', 'price_list', 'cash_session', 'user', 'role', 'report', 'settings',
  /* Quotations, sales orders and purchase orders. Separate from `bill` on
     purpose: a purchase order commits the shop's money to a supplier, and
     somebody trusted to ring up a sale is not automatically somebody trusted to
     do that. */
  'document',
  /* Selling or pricing anything below what it cost (`services/belowCost.ts`).
     Its own row, because the person trusted to ring up a bill or set a price
     is not by that alone trusted to give goods away under cost. Only `write`
     is read: "may go ahead after confirming". Admin's by default. */
  'below_cost',
] as const
export type Resource = (typeof RESOURCES)[number]

export const PAGES = [
  'dashboard', 'billing', 'bills', 'inventory', 'stock_in', 'stock_count', 'reorder', 'suppliers',
  'customers', 'credit', 'cash_counter', 'pricing', 'registers', 'reports', 'audit', 'users', 'roles', 'settings',
  'formats', 'orders', 'purchase_orders',
] as const
export type Page = (typeof PAGES)[number]

export const CAPABILITIES = [
  'read', 'create', 'write', 'delete', 'submit', 'cancel', 'amend',
] as const
export type Capability = (typeof CAPABILITIES)[number]

export type ResourcePermissions = Record<Capability, boolean>

/**
 * Which capabilities the software actually checks, per resource -- in a
 * service, which refuses the call (`requirePermission`), and usually in the
 * screen as well, which hides the button. `servicePermissions.test.ts` holds
 * the services to this list and `permissionsHonest.test.tsx` the screens.
 *
 * The grid on the Roles screen offered every capability against every resource
 * — ninety-eight checkboxes — and eleven of them were read by anything. An
 * owner could take away a cashier's right to add a customer and watch them add
 * one. A switch that changes nothing is the worst thing this product can ship,
 * so the ones with no check behind them are now shown as blanks with a line
 * saying why, the same way an unfinished format block is.
 *
 * The stored permissions are untouched: a role still carries every bit, and a
 * capability appears here the moment something reads it. Keep this list honest
 * — it is a claim about the code, not a wish.
 */
export const ENFORCED: Record<Resource, readonly Capability[]> = {
  bill: ['create', 'write', 'cancel'],
  sales_return: ['create', 'submit', 'cancel'],
  payment: ['create', 'cancel'],
  stock_entry: ['submit'],
  product: ['write'],
  customer: ['create', 'write'],
  supplier: ['create', 'write', 'delete'],
  price_list: ['write'],
  cash_session: ['create', 'write', 'submit'],
  user: ['create', 'write'],
  role: ['create', 'write', 'delete'],
  /* Reaching the screen at all is the control on reports: a page a role was
     not granted is not in the sidebar and cannot be routed to. Settings are
     the same, except for closing the books, which a service refuses on its
     own -- it is the one setting that stops other people's work. */
  report: [],
  settings: ['write'],
  document: ['create', 'cancel'],
  below_cost: ['write'],
}

/** Whether ticking this box would change anything. */
export function isEnforced(resource: Resource, capability: Capability): boolean {
  return ENFORCED[resource].includes(capability)
}

export interface PermissionSet {
  roleId: string
  roleName: string
  resources: Partial<Record<Resource, ResourcePermissions>>
  pages: Set<string>
}

export class PermissionError extends Error {
  constructor(
    readonly resource: string,
    readonly capability: Capability,
  ) {
    super(`Not permitted: ${capability} on ${resource}`)
    this.name = 'PermissionError'
  }
}

export async function loadPermissions(db: SqlDriver, roleId: string): Promise<PermissionSet> {
  const role = await db.get<{ id: string; name: string }>(`SELECT id, name FROM roles WHERE id = ?`, [roleId])
  if (!role) throw new Error(`unknown role: ${roleId}`)

  const permRows = await db.query<{
    resource: string
    can_read: number; can_create: number; can_write: number
    can_delete: number; can_submit: number; can_cancel: number; can_amend: number
  }>(`SELECT * FROM role_permissions WHERE role_id = ?`, [roleId])

  const resources: Partial<Record<Resource, ResourcePermissions>> = {}
  for (const row of permRows) {
    resources[row.resource as Resource] = {
      read: !!row.can_read,
      create: !!row.can_create,
      write: !!row.can_write,
      delete: !!row.can_delete,
      submit: !!row.can_submit,
      cancel: !!row.can_cancel,
      amend: !!row.can_amend,
    }
  }

  const pageRows = await db.query<{ page_key: string }>(
    `SELECT page_key FROM role_pages WHERE role_id = ? AND visible = 1`,
    [roleId],
  )

  return {
    roleId: role.id,
    roleName: role.name,
    resources,
    pages: new Set(pageRows.map((r) => r.page_key)),
  }
}

export function can(perms: PermissionSet, resource: Resource, capability: Capability): boolean {
  return perms.resources[resource]?.[capability] ?? false
}

export function assertCan(perms: PermissionSet, resource: Resource, capability: Capability): void {
  if (!can(perms, resource, capability)) throw new PermissionError(resource, capability)
}

const CAPABILITY_COLUMN: Record<Capability, string> = {
  read: 'can_read', create: 'can_create', write: 'can_write', delete: 'can_delete',
  submit: 'can_submit', cancel: 'can_cancel', amend: 'can_amend',
}

/**
 * Refuses unless `actorId` is an active user whose role may do this.
 *
 * The screens hide what a role may not do, and until 4 October that was the
 * whole of the control: every service took an `actorId`, wrote it into the
 * audit log, and never asked whether that person was allowed. A screen that
 * forgot to hide a button, or any caller that is not a screen -- the cloud
 * peer, a phone, a script -- went straight through. So each service that does
 * something `ENFORCED` names asks here first, against the database rather
 * than a permission set a screen loaded at sign-in, so a role changed on
 * another till binds as soon as it has synced.
 *
 * Thrown rather than returned: the screens already hide the button, so
 * arriving here refused means something is wrong, not that a person made a
 * choice the screen should explain.
 */
export async function requirePermission(
  db: SqlDriver,
  actorId: string | null | undefined,
  resource: Resource,
  capability: Capability,
): Promise<void> {
  if (!actorId) throw new PermissionError(resource, capability)
  /* raw: the column is chosen by the capability at run time, from a closed
     list above, so the builder cannot name it. */
  const row = await db.get<{ is_active: number; allowed: number | null }>(
    `SELECT u.is_active, p.${CAPABILITY_COLUMN[capability]} AS allowed
       FROM users u
       LEFT JOIN role_permissions p ON p.role_id = u.role_id AND p.resource = ?
      WHERE u.id = ?`,
    [resource, actorId],
  )
  if (!row || row.is_active !== 1 || row.allowed !== 1) throw new PermissionError(resource, capability)
}

export function canSeePage(perms: PermissionSet, page: string): boolean {
  return perms.pages.has(page)
}

export function visiblePages(perms: PermissionSet): Page[] {
  return PAGES.filter((p) => perms.pages.has(p))
}

export function noPermissions(): ResourcePermissions {
  return { read: false, create: false, write: false, delete: false, submit: false, cancel: false, amend: false }
}

export function fullPermissions(): ResourcePermissions {
  return { read: true, create: true, write: true, delete: true, submit: true, cancel: true, amend: true }
}

/**
 * Seeded roles. These are starting points the owner edits, not fixed tiers —
 * a shop that wants its stockist to issue bills just ticks the box.
 */
export interface RoleTemplate {
  name: string
  description: string
  resources: Partial<Record<Resource, Partial<ResourcePermissions>>>
  pages: Page[]
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    name: 'Admin',
    description: 'Full access, including staff and permissions',
    resources: Object.fromEntries(RESOURCES.map((r) => [r, fullPermissions()])),
    pages: [...PAGES],
  },
  {
    name: 'Manager',
    description: 'Everything operational; cannot change staff or permissions',
    resources: {
      bill: fullPermissions(),
      sales_return: fullPermissions(),
      payment: fullPermissions(),
      stock_entry: fullPermissions(),
      product: fullPermissions(),
      customer: fullPermissions(),
      supplier: fullPermissions(),
      price_list: fullPermissions(),
      cash_session: fullPermissions(),
      document: fullPermissions(),
      report: { read: true },
      settings: { read: true },
    },
    pages: ['dashboard', 'billing', 'bills', 'inventory', 'stock_in', 'stock_count', 'reorder', 'suppliers', 'customers', 'credit', 'cash_counter', 'pricing', 'registers', 'reports', 'orders', 'purchase_orders'],
  },
  {
    name: 'Cashier',
    description: 'Bills and takes payment; cannot cancel or change prices',
    resources: {
      bill: { read: true, create: true, write: true, submit: true },
      /* Sees the returns against a bill, does not take one. A refund is money
         out of the drawer against goods nobody has checked yet, and a shop that
         wants its cashiers doing it ticks the two boxes on the Roles screen.
         Create without submit would be worse than either: a return is taken
         complete, so it would be a permission that does nothing at all. */
      sales_return: { read: true },
      payment: { read: true, create: true, submit: true },
      product: { read: true },
      customer: { read: true, create: true, write: true },
      cash_session: { read: true, create: true, submit: true },
    },
    pages: ['billing', 'bills', 'customers', 'cash_counter'],
  },
  {
    name: 'Stockist',
    description: 'Stock and products; no billing, no money',
    resources: {
      product: { read: true, create: true, write: true },
      stock_entry: { read: true, create: true, write: true, submit: true },
      supplier: { read: true, create: true, write: true },
      /* A stockist raises the purchase order for what the shelf is short of.
         Nothing here lets them sell, and a purchase order moves no money. */
      document: { read: true, create: true, write: true, submit: true },
      report: { read: true },
    },
    pages: ['dashboard', 'inventory', 'stock_in', 'stock_count', 'reorder', 'suppliers', 'reports', 'purchase_orders'],
  },
]
