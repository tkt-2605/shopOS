import { useCallback, useEffect, useState } from 'react'
import { Permissions, shopProgress, setupHidden, hideSetup, type Page, type ShopProgress } from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { useShopChanged } from '../core/useShopChanged'
import { deviceSetting } from '../core/device'
import { goTo } from '../core/nav'
import { openSettings, type SettingsSection } from '../pages/Settings'

/**
 * Getting a new shop from "it opens" to "its bills are right".
 *
 * Every step ticks itself off from what the shop has actually done -- see
 * `services/setup.ts` -- so there is nothing to mark and nothing to get out of
 * step. The shop's steps come from the database and are the same on every
 * till; the printer and where backups go are this machine's own, read from
 * its device settings.
 *
 * Shown on the Dashboard to whoever may open Settings, which is the owner and
 * not the cashier. It goes when every step that matters is done, or when
 * somebody puts it away; putting it away is shared, so it goes from every till.
 */

type Step = {
  id: string
  title: string
  why: string
  done: boolean
  optional?: boolean
  go: { label: string; page?: Page; settings?: SettingsSection }
}

function stepsFor(shop: ShopProgress): Step[] {
  return [
    {
      id: 'shop', title: 'Shop address and state', done: shop.shopDetails,
      why: 'Printed on every bill. The state decides whether a sale is CGST and SGST or IGST.',
      go: { label: 'Shop details', settings: 'shop' },
    },
    {
      id: 'tax', title: 'Say whether you are GST registered', done: shop.taxScheme,
      why: 'Decides the heading on the bill and whether tax is charged at all.',
      go: { label: 'Tax & billing', settings: 'tax' },
    },
    {
      id: 'printer', title: 'Choose the receipt printer', done: deviceSetting('thermal_printer') !== null,
      why: 'For this computer. Skip it if you only print A4.',
      optional: true,
      go: { label: 'Receipt printer', settings: 'printer' },
    },
    {
      id: 'items', title: 'Add your items', done: shop.items,
      why: 'One by one, or all at once from a spreadsheet with Import from CSV.',
      go: { label: 'Inventory', page: 'inventory' },
    },
    {
      id: 'stock', title: 'Enter what is on the shelf', done: shop.openingStock,
      why: 'Opening stock, so the counts and the value of stock start right.',
      go: { label: 'Stock in', page: 'stock_in' },
    },
    {
      id: 'staff', title: 'Give each cashier their own login', done: shop.staff,
      why: 'So every bill says who made it. Skip it if you work the counter alone.',
      optional: true,
      go: { label: 'Counters & staff', settings: 'team' },
    },
    {
      id: 'backups', title: 'Send backups somewhere off this computer',
      done: deviceSetting('backup_folder') !== null || deviceSetting('backup_hook') !== null,
      why: 'A USB stick or a Google Drive folder. A backup on the same disk dies with it.',
      go: { label: 'Backups', settings: 'backups' },
    },
    {
      id: 'bill', title: 'Take your first bill', done: shop.firstBill,
      why: 'Scan or search an item, then F12 to take payment.',
      go: { label: 'Billing', page: 'billing' },
    },
  ]
}

export function SetupChecklist() {
  const { db } = useCore()
  const user = useUser()
  const [shop, setShop] = useState<ShopProgress | null>(null)
  const [hidden, setHidden] = useState(true)

  const load = useCallback(async () => {
    setHidden(await setupHidden(db))
    setShop(await shopProgress(db))
  }, [db])
  useEffect(() => { void load() }, [load])
  useShopChanged(load)

  const pages = Permissions.visiblePages(user.permissions)
  if (!pages.includes('settings') || hidden || shop === null) return null

  const steps = stepsFor(shop)
  const needed = steps.filter((s) => !s.optional)
  if (needed.every((s) => s.done)) return null
  const doneCount = steps.filter((s) => s.done).length

  const open = (step: Step) => {
    if (step.go.settings) openSettings(step.go.settings)
    else if (step.go.page) goTo(step.go.page)
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Getting started</h2>
        <span className="src">{doneCount} of {steps.length} done</span>
        <div className="spacer" />
        <button className="btn sm" onClick={() => { void hideSetup(db, true).then(() => setHidden(true)) }}>
          Hide this list
        </button>
      </div>
      <div className="card-body setup-steps">
        {steps.map((step) => (
          <div key={step.id} className="setup-step" data-done={step.done ? 'yes' : 'no'}>
            <span className="setup-mark" aria-label={step.done ? 'done' : 'to do'}>{step.done ? '✓' : ''}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{step.title}{step.optional && <span className="src"> · optional</span>}</div>
              {!step.done && <div className="src">{step.why}</div>}
            </div>
            {!step.done && (
              <button className="btn sm" onClick={() => open(step)}>{step.go.label}</button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
