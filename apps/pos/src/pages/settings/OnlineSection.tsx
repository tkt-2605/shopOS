import { useEffect, useState } from 'react'
import { listCategories, type Category } from '@shopos/core'
import {
  loadWebSettings, saveWebSettings, isOnlineOrderShop, listedCategoryIds, listedWithoutPhoto, type WebSettings,
} from '@shopos/core/web'
import { useCore, useUser } from '../../core/CoreProvider'
import { keepTheStorefrontRight, storefrontRefusal, webPort, webServingOn } from '../../core/webHost'
import { Alert, Card, Field } from '../../ui/components'
import { Intro, Switch } from './parts'

/**
 * Online orders: the storefront this shop's main till answers.
 *
 * Shown only to a shop online orders were built for (`ONLINE_ORDER_SHOPS`).
 * Everything here is the shop's and travels to every till; which port the
 * tunnel reaches is this machine's, and is the one `cloudflared` is told.
 */

const WHY: Record<string, string> = {
  NOT_THIS_SHOP: 'This shop is not set up for online orders.',
  TURNED_OFF: 'Online orders are off.',
  NOT_THE_MAIN: 'This till is not the main. Only the main till answers the storefront.',
  SWITCHED_OFF: 'Online orders have been switched off from the vendor’s side for now. The counter is not affected.',
}

/** Whether to show this section at all: only to a shop online orders are for. */
export function useSellsOnline(): boolean {
  const { db } = useCore()
  const [yes, setYes] = useState(false)
  useEffect(() => {
    let live = true
    void isOnlineOrderShop(db).then((v) => { if (live) setYes(v) }).catch(() => undefined)
    return () => { live = false }
  }, [db])
  return yes
}

export function OnlineSection() {
  const { db } = useCore()
  const user = useUser()
  const [settings, setSettings] = useState<WebSettings | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [serving, setServing] = useState<{ port: number | null; why: string | null }>({ port: null, why: null })
  const [error, setError] = useState<string | null>(null)
  const [noPhoto, setNoPhoto] = useState<{ id: string; name: string }[]>([])

  async function refreshStatus() {
    await keepTheStorefrontRight(db)
    const why = await storefrontRefusal(db)
    setServing({ port: await webServingOn(), why: why === null ? null : WHY[why] ?? why })
  }

  useEffect(() => {
    void listedCategoryIds(db).then((ids) => listedWithoutPhoto(db, ids)).then(setNoPhoto)
  }, [db, settings?.categoryIds.join(',')])

  useEffect(() => {
    void loadWebSettings(db).then(setSettings)
    void listCategories(db).then(setCategories)
    void refreshStatus()
  }, [db])

  async function save(changes: Partial<WebSettings>) {
    setError(null)
    try {
      setSettings(await saveWebSettings(db, user.id, changes))
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!settings) return null
  const chosen = new Set(settings.categoryIds)

  return (
    <>
      <Intro>
        Customers browse your items on their phone and order to collect and pay at the counter.
        The main till answers them. When it is off, the storefront says the shop is closed.
      </Intro>

      {error && <Alert>{error}</Alert>}

      <Card title="Taking orders">
        <Switch
          id="web-enabled"
          on={settings.enabled}
          onChange={(on) => void save({ enabled: on })}
          title="Online orders"
          note={'On, the main till answers the storefront: your listed items, sign-in and orders. '
            + 'Off, it answers nothing and the storefront says it cannot reach the shop. Orders '
            + 'already taken stay on the Orders page either way.'}
        />
        <Switch
          id="web-open"
          on={settings.open}
          onChange={(on) => void save({ open: on })}
          title="Open for new orders now"
          note={'Off, customers can still browse and see their orders, and are told the shop is '
            + 'closed for new ones. Turn it off at closing time or on a busy day.'}
        />
        <p className="hint">
          {serving.port !== null
            ? `Answering on 127.0.0.1:${serving.port}. The tunnel on this computer must point there.`
            : serving.why ?? `Not answering yet. The tunnel should point at 127.0.0.1:${webPort()}.`}
        </p>
      </Card>

      <Card title="What is listed">
        <p className="hint">
          Items in the categories ticked here, and in every category under them, are listed with
          their normal price. Retired items and items priced at the counter are never listed.
        </p>
        {categories.length === 0 && <p className="hint">No categories yet. Add them under Inventory.</p>}
        {categories.filter((c) => c.parentId === null).map((c) => (
          <label key={c.id} className="settings-switch">
            <input
              type="checkbox"
              checked={chosen.has(c.id)}
              onChange={(e) => {
                const next = new Set(chosen)
                if (e.target.checked) next.add(c.id)
                else next.delete(c.id)
                void save({ categoryIds: [...next] })
              }}
            />
            <span>
              <span className="settings-option-title">{c.name}</span>
              <span className="settings-option-note">
                {c.productCount} item{c.productCount === 1 ? '' : 's'}
                {categories.some((s) => s.parentId === c.id) ? ', and the categories under it' : ''}
              </span>
            </span>
          </label>
        ))}
      </Card>

      {noPhoto.length > 0 && (
        <Card title={`Listed without a photo (${noPhoto.length})`}>
          <p className="hint">
            These show a blank square on the storefront. Add a photo on the main till: Inventory, open the
            item, Photo for the storefront.
          </p>
          <p>{noPhoto.slice(0, 60).map((p) => p.name).join(' · ')}{noPhoto.length > 60 ? ` and ${noPhoto.length - 60} more` : ''}</p>
        </Card>
      )}

      <Card title="Storefront">
        <TextSetting
          label="Storefront address"
          hint="Where customers open the shop, e.g. https://shop.example.in. The till answers no other site."
          value={settings.origin ?? ''}
          onSave={(v) => save({ origin: v || null })}
        />
        <TextSetting
          label="Google client id"
          hint="From Google Cloud, for “Sign in with Google”. Ends in .apps.googleusercontent.com."
          value={settings.googleClientId ?? ''}
          onSave={(v) => save({ googleClientId: v || null })}
        />
        <TextSetting
          label="Minutes to answer an order"
          hint="An order nobody accepts in this time is turned away, so the customer is not left waiting."
          value={String(settings.answerMinutes)}
          onSave={(v) => save({ answerMinutes: Number(v) || settings.answerMinutes })}
        />
        <TextSetting
          label="Days to collect"
          hint="An accepted order not collected in this many days is marked overdue on the Orders page."
          value={String(settings.collectDays)}
          onSave={(v) => save({ collectDays: Number(v) || settings.collectDays })}
        />
      </Card>
    </>
  )
}

function TextSetting({ label, hint, value, onSave }: {
  label: string; hint: string; value: string; onSave: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <Field label={label} hint={hint}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft.trim() !== value) onSave(draft.trim()) }}
      />
    </Field>
  )
}
