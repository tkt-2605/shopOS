import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  listRoles, loadRoleMatrix, createRole, renameRole, saveRoleMatrix, deleteRole,
  Permissions, type RoleSummary, type RoleMatrix,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Card, Modal, Field, Empty, Alert } from '../ui/components'

type Resource = Permissions.Resource
type Capability = Permissions.Capability
type Page = Permissions.Page

const RESOURCE_LABELS: Record<Resource, { name: string; note: string }> = {
  bill: { name: 'Bills', note: 'Sales at the counter' },
  sales_return: { name: 'Returns', note: 'Goods brought back' },
  payment: { name: 'Payments', note: 'Money received against credit' },
  stock_entry: { name: 'Stock entries', note: 'Goods in and adjustments' },
  product: { name: 'Products', note: 'The catalogue' },
  customer: { name: 'Customers', note: 'Names, phone, credit limit' },
  supplier: { name: 'Suppliers', note: 'Who you buy from' },
  price_list: { name: 'Price lists', note: 'Rates and tiers' },
  cash_session: { name: 'Cash drawer', note: 'Opening and closing a till' },
  user: { name: 'Staff', note: 'Accounts and passwords' },
  role: { name: 'Roles', note: 'This screen' },
  report: { name: 'Reports', note: 'Sales and tax figures' },
  settings: { name: 'Settings', note: 'Shop-wide configuration' },
}

const CAPABILITY_LABELS: Record<Capability, string> = {
  read: 'View',
  create: 'Add',
  write: 'Edit',
  delete: 'Delete',
  submit: 'Submit',
  cancel: 'Cancel',
  amend: 'Amend',
}

const PAGE_GROUPS: { label: string; pages: Page[] }[] = [
  { label: 'Sell', pages: ['billing', 'bills', 'customers'] },
  { label: 'Stock', pages: ['inventory', 'stock_in', 'stock_count', 'reorder', 'suppliers'] },
  { label: 'Money', pages: ['credit', 'cash_counter'] },
  { label: 'Review', pages: ['dashboard', 'reports', 'audit'] },
  { label: 'Setup', pages: ['pricing', 'registers', 'users', 'roles', 'settings'] },
]

const PAGE_LABELS: Record<Page, string> = {
  dashboard: 'Dashboard',
  billing: 'Billing',
  bills: 'Bills',
  inventory: 'Inventory',
  stock_in: 'Stock In',
  stock_count: 'Stock Count',
  reorder: 'Buying List',
  suppliers: 'Suppliers',
  customers: 'Customers',
  credit: 'Credit',
  cash_counter: 'Cash Counter',
  pricing: 'Prices',
  registers: 'Counters',
  reports: 'Reports',
  audit: 'History',
  users: 'Staff',
  roles: 'Roles & Permissions',
  settings: 'Settings',
}

export default function Roles() {
  const { db } = useCore()
  const user = useUser()
  const [roles, setRoles] = useState<RoleSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<RoleMatrix | null>(null)
  const [saved, setSaved] = useState<RoleMatrix | null>(null)
  const [adding, setAdding] = useState<{ name: string; copyFromId: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refreshRoles = useCallback(async () => {
    const rows = await listRoles(db)
    setRoles(rows)
    setSelectedId((current) => current ?? rows[0]?.id ?? null)
  }, [db])

  useEffect(() => { void refreshRoles() }, [refreshRoles])

  useEffect(() => {
    if (!selectedId) return
    void loadRoleMatrix(db, selectedId).then((m) => { setDraft(m); setSaved(m) })
  }, [db, selectedId])

  const dirty = useMemo(
    () => draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  )

  function toggleCapability(resource: Resource, capability: Capability) {
    setDraft((d) => {
      if (!d) return d
      const current = d.resources[resource]
      const next = { ...current, [capability]: !current[capability] }
      // Nothing else is meaningful without View, and View is what a hidden page
      // would contradict — so the two move together rather than drifting apart.
      if (capability !== 'read' && next[capability]) next.read = true
      if (capability === 'read' && !next.read) {
        for (const c of Permissions.CAPABILITIES) next[c] = false
      }
      return { ...d, resources: { ...d.resources, [resource]: next } }
    })
  }

  function togglePage(page: Page) {
    setDraft((d) => (d ? { ...d, pages: { ...d.pages, [page]: !d.pages[page] } } : d))
  }

  function setRow(resource: Resource, on: boolean) {
    setDraft((d) => {
      if (!d) return d
      const next = on ? Permissions.fullPermissions() : Permissions.noPermissions()
      return { ...d, resources: { ...d.resources, [resource]: next } }
    })
  }

  async function save() {
    if (!draft) return
    setError(null)
    const result = await saveRoleMatrix(db, {
      roleId: draft.id, resources: draft.resources, pages: draft.pages, actorId: user.id,
    })
    if (!result.ok) {
      setError(
        result.code === 'WOULD_LOCK_OUT'
          ? 'Saving this would leave nobody able to open this screen. Give another active member of staff a role that can edit roles first.'
          : 'That name is already taken.',
      )
      return
    }
    setSaved(draft)
    setNotice('Saved. Staff on this role see the change the next time they sign in.')
    setTimeout(() => setNotice(null), 4000)
    await refreshRoles()
  }

  async function add() {
    if (!adding) return
    setError(null)
    const result = await createRole(db, {
      name: adding.name,
      ...(adding.copyFromId ? { copyFromId: adding.copyFromId } : {}),
      actorId: user.id,
    })
    if (!result.ok) { setError('A role with that name already exists.'); return }
    setAdding(null)
    await refreshRoles()
    setSelectedId(result.roleId)
  }

  async function remove(role: RoleSummary) {
    setError(null)
    const result = await deleteRole(db, { roleId: role.id, actorId: user.id })
    if (!result.ok) {
      setError(
        result.code === 'IN_USE' ? result.message
        : result.code === 'SYSTEM_ROLE' ? 'The four roles that ship with ShopOS cannot be removed. Switch off everything it may do instead.'
        : 'That would leave nobody able to administer the shop.',
      )
      return
    }
    setSelectedId(null)
    setDraft(null)
    await refreshRoles()
  }

  async function rename(role: RoleSummary) {
    const name = window.prompt('Rename this role', role.name)
    if (name === null || name.trim() === '') return
    const result = await renameRole(db, { roleId: role.id, name, actorId: user.id })
    if (!result.ok) { setError('A role with that name already exists.'); return }
    await refreshRoles()
    setDraft((d) => (d ? { ...d, name: name.trim() } : d))
    setSaved((d) => (d ? { ...d, name: name.trim() } : d))
  }

  const selected = roles.find((r) => r.id === selectedId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 208px' }}>
          <Card
            title="Roles"
            actions={<button className="btn sm" onClick={() => setAdding({ name: '', copyFromId: '' })}>New</button>}
          >
            <div className="side-list">
              {roles.map((r) => (
                <button key={r.id} aria-current={r.id === selectedId} onClick={() => setSelectedId(r.id)}>
                  {r.name}
                  <span className="count"> · {r.userCount}</span>
                </button>
              ))}
            </div>
          </Card>
        </div>

        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!draft || !selected ? (
            <Card><Empty>Pick a role</Empty></Card>
          ) : (
            <>
              <Card
                title={`${selected.name} — pages`}
                actions={
                  <>
                    <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                      {selected.userCount} {selected.userCount === 1 ? 'person' : 'people'}
                    </span>
                    <button className="btn ghost sm" onClick={() => void rename(selected)}>Rename</button>
                    {!selected.isSystem && (
                      <button className="btn ghost sm" onClick={() => void remove(selected)}>Delete</button>
                    )}
                    <button className="btn primary sm" disabled={!dirty} onClick={() => void save()}>
                      {dirty ? 'Save changes' : 'Saved'}
                    </button>
                  </>
                }
              >
                <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 12 }}>
                  A page that is off is missing from the sidebar and cannot be reached any other way.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {PAGE_GROUPS.map((group) => (
                    <div key={group.label}>
                      <div style={{
                        fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em',
                        textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 5,
                      }}>
                        {group.label}
                      </div>
                      <div className="page-toggles">
                        {group.pages.map((page) => (
                          <label key={page}>
                            <input
                              type="checkbox" checked={draft.pages[page]} onChange={() => togglePage(page)}
                            />
                            {PAGE_LABELS[page]}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card title={`${selected.name} — what they may do`}>
                <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 12 }}>
                  Submit turns a draft into a real document. Cancel reverses one that was already
                  submitted, and Amend reopens it as a corrected copy — a cashier usually has the
                  first without the other two.
                </div>
                <div className="card card-scroll">
                  <table className="grid-table">
                    <thead>
                      <tr>
                        <th>Area</th>
                        {Permissions.CAPABILITIES.map((c) => (
                          <th key={c} className="cap">{CAPABILITY_LABELS[c]}</th>
                        ))}
                        <th style={{ width: 54 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {Permissions.RESOURCES.map((resource) => {
                        const perms = draft.resources[resource]
                        const all = Permissions.CAPABILITIES.every((c) => perms[c])
                        return (
                          <tr key={resource}>
                            <td className="grid-res">
                              {RESOURCE_LABELS[resource].name}
                              <div className="sub">{RESOURCE_LABELS[resource].note}</div>
                            </td>
                            {Permissions.CAPABILITIES.map((c) => (
                              <td key={c} className="cap">
                                <input
                                  type="checkbox"
                                  checked={perms[c]}
                                  onChange={() => toggleCapability(resource, c)}
                                  aria-label={`${CAPABILITY_LABELS[c]} ${RESOURCE_LABELS[resource].name}`}
                                />
                              </td>
                            ))}
                            <td className="r">
                              <button className="btn ghost sm" onClick={() => setRow(resource, !all)}>
                                {all ? 'None' : 'All'}
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>

      {adding && (
        <Modal
          title="New role"
          onClose={() => setAdding(null)}
          footer={<>
            <button className="btn" onClick={() => setAdding(null)}>Cancel</button>
            <button className="btn primary" disabled={adding.name.trim() === ''} onClick={() => void add()}>Create</button>
          </>}
        >
          <Field label="Name">
            <input className="input" id="role-name" autoFocus value={adding.name}
              onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Evening Cashier" />
          </Field>
          <Field label="Start from" hint="Copies an existing role's ticks, which you can then adjust.">
            <select className="select" id="role-copy" value={adding.copyFromId}
              onChange={(e) => setAdding({ ...adding, copyFromId: e.target.value })}>
              <option value="">Nothing — start with everything off</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
        </Modal>
      )}
    </div>
  )
}
