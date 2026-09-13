import type { SqlDriver } from '../db/driver.js'

/**
 * Permissions and page visibility come from the same tables, so a page the owner
 * hides is also a route the user cannot reach and a service call they cannot make.
 * Nothing here is hardcoded — the shop owner configures their own staff.
 */

export const RESOURCES = [
  'bill', 'sales_return', 'payment', 'stock_entry', 'product', 'customer',
  'supplier', 'price_list', 'cash_session', 'user', 'role', 'report', 'settings',
] as const
export type Resource = (typeof RESOURCES)[number]

export const PAGES = [
  'dashboard', 'billing', 'bills', 'inventory', 'stock_in', 'stock_count', 'reorder', 'suppliers',
  'customers', 'credit', 'cash_counter', 'pricing', 'reports', 'users', 'roles', 'settings',
] as const
export type Page = (typeof PAGES)[number]

export const CAPABILITIES = [
  'read', 'create', 'write', 'delete', 'submit', 'cancel', 'amend',
] as const
export type Capability = (typeof CAPABILITIES)[number]

export type ResourcePermissions = Record<Capability, boolean>

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
      report: { read: true },
      settings: { read: true },
    },
    pages: ['dashboard', 'billing', 'bills', 'inventory', 'stock_in', 'stock_count', 'reorder', 'suppliers', 'customers', 'credit', 'cash_counter', 'pricing', 'reports'],
  },
  {
    name: 'Cashier',
    description: 'Bills and takes payment; cannot cancel or change prices',
    resources: {
      bill: { read: true, create: true, write: true, submit: true },
      sales_return: { read: true, create: true },
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
      report: { read: true },
    },
    pages: ['dashboard', 'inventory', 'stock_in', 'stock_count', 'reorder', 'suppliers', 'reports'],
  },
]
