import { useEffect, useState } from 'react'
import { listCategories, isOn, loadShopProfile, type Category, type ShopProfile } from '@shopos/core'
import {
  loadWebSettings, saveWebSettings, isOnlineOrderShop, listedCategoryIds, listedWithoutPhoto, listedPhotoFiles, republishCatalog, type WebSettings,
} from '@shopos/core/web'
import { useCore, useUser } from '../../core/CoreProvider'
import { keepTheStorefrontRight, storefrontPortTrouble, storefrontRefusal, tunnelProblem, tunnelState, webPort, webServingOn, webSettingsChanged, type TunnelState } from '../../core/webHost'
import { setStartsWithWindows, startsWithWindows } from '../../core/autostart'
import { cloudReady, pushShop } from '../../core/cloudShop'
import { filePresent } from '../../core/attachments'
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
  /* What only the main's own disk holds, and so does not come with becoming the main. */
  const [photoNotHere, setPhotoNotHere] = useState<string[]>([])
  const [cloudKey, setCloudKey] = useState<boolean | null>(null)
  const [tiered, setTiered] = useState(true)
  const [profile, setProfile] = useState<ShopProfile | null>(null)
  const [published, setPublished] = useState<string | null>(null)
  const [tunnel, setTunnel] = useState<TunnelState | null>(null)
  const [atSignIn, setAtSignIn] = useState(false)

  async function refreshStatus() {
    await keepTheStorefrontRight(db)
    const why = await storefrontRefusal(db)
    setServing({ port: await webServingOn(), why: why === null ? storefrontPortTrouble() : WHY[why] ?? why })
    setTunnel(await tunnelState())
  }

  useEffect(() => {
    void listedCategoryIds(db).then((ids) => listedWithoutPhoto(db, ids)).then(setNoPhoto)
    void listedCategoryIds(db).then((ids) => listedPhotoFiles(db, ids)).then(async (items) => {
      const missing: string[] = []
      for (const item of items) {
        const here = await Promise.all(item.paths.map(filePresent))
        if (here.includes(false)) missing.push(item.name)
      }
      setPhotoNotHere(missing)
    })
    void cloudReady().then(setCloudKey)
  }, [db, settings?.categoryIds.join(',')])

  useEffect(() => {
    void isOn(db, 'tieredPricing').then(setTiered).catch(() => undefined)
    void loadShopProfile(db).then(setProfile).catch(() => undefined)
    void loadWebSettings(db).then(setSettings)
    void listCategories(db).then(setCategories)
    void refreshStatus()
    void startsWithWindows().then(setAtSignIn)
  }, [db])

  async function save(changes: Partial<WebSettings>) {
    setError(null)
    try {
      setSettings(await saveWebSettings(db, user.id, changes))
      /* Out to phones now, not within the minute: a till closed straight after
         a change would otherwise never have published it. */
      await republishCatalog(db).catch(() => undefined)
      await refreshStatus()
      await webSettingsChanged(db)
      void pushShop(db)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function publishNow() {
    setPublished('Publishing…')
    try {
      const r = await republishCatalog(db)
      await pushShop(db)
      setPublished(`${r.items} item${r.items === 1 ? '' : 's'} published${r.changed ? ', with changes' : ', nothing had changed'}. `
        + 'Phones see it at their next refresh, or within about two minutes.')
    } catch (err) {
      setPublished(null)
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
        {serving.port !== null && (
          <p className="hint">
            {tunnel === null
              ? tunnelProblem() ?? 'The tunnel is run outside the till on this computer.'
              : tunnel.up
                ? `Tunnel running, started by this till${tunnel.restarts > 0 ? `, restarted ${tunnel.restarts} time${tunnel.restarts === 1 ? '' : 's'}` : ''}.`
                : `Tunnel down, trying again: ${tunnel.problem ?? 'starting'}.`}
          </p>
        )}
        <Switch
          id="web-autostart"
          on={atSignIn}
          onChange={(on) => void setStartsWithWindows(on).then(setAtSignIn).catch((err) => setError(String(err)))}
          title="Start this till with Windows"
          note={'On, Windows opens this till when someone signs in after the computer is turned on, and '
            + 'the main till then opens the online shop and its tunnel by itself. Turn it on for the main till. '
            + 'For the shop to come online with nobody at the computer, Windows must also sign in by itself.'}
        />
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button className="btn" onClick={() => void publishNow()}>Publish items now</button>
          <span className="hint">
            {published ?? 'Changes to items, prices, stock and photos go out within a minute by themselves. This sends them now.'}
          </span>
        </div>
      </Card>

      <Card title="Prices">
        <Switch
          id="web-quotes"
          on={settings.quotes}
          onChange={(on) => void save({ quotes: on })}
          title="Prices on request (quotation)"
          note={'On, customers see each item’s name and photo but no price. They send what they want, '
            + 'and you answer with a quotation from the order (Send quotation): your prices for it. They '
            + 'accept or cancel, and an accepted one comes back to you to accept as usual.'}
        />
        <Switch
          id="web-tiers"
          on={settings.tiers}
          onChange={(on) => void save({ tiers: on })}
          title="Show quantity prices online"
          note={'On, an item with a quantity ladder shows it to customers: “10 or more at ₹9 each”, and '
            + 'the cart tells them how much more to add to save. Off, they see only the price of one.'}
        />
        {settings.tiers && !tiered && (
          <p className="hint">Tiered pricing is off for the shop, so there are no quantity prices to show. Turn it on under Features.</p>
        )}
      </Card>

      <Card title="Contact and WhatsApp">
        <p className="hint">
          {profile?.address || profile?.phone
            ? `From Shop details: ${[profile.address, profile.phone, profile.email].filter(Boolean).join(' · ')}.`
            : 'Shop details has no address or phone yet, so the storefront has none to show. Add them under Settings, Shop details.'}
        </p>
        <Switch
          id="web-contact"
          on={settings.contact}
          onChange={(on) => void save({ contact: on })}
          title="Show the shop’s contact details"
          note="Address, phone, email and opening hours on the storefront, with Call and Directions."
        />
        <Switch
          id="web-wa-chat"
          on={settings.whatsappChat}
          onChange={(on) => void save({ whatsappChat: on })}
          title="WhatsApp the shop"
          note="A WhatsApp button on the storefront that opens a chat with the number below."
        />
        <Switch
          id="web-wa-cart"
          on={settings.whatsappCart}
          onChange={(on) => void save({ whatsappCart: on })}
          title="Send cart on WhatsApp"
          note={'A button in the cart that sends the list and total to the shop’s WhatsApp. It needs no sign-in and '
            + 'works even while this till is off; you reply and bill it at the counter as usual.'}
        />
        <TextSetting
          label="WhatsApp number"
          hint={`Leave empty to use the shop’s phone${profile?.phone ? ` (${profile.phone})` : ''}. A 10-digit mobile is taken as Indian.`}
          value={settings.whatsapp ?? ''}
          onSave={(v) => save({ whatsapp: v || null })}
        />
      </Card>

      {cloudKey === false && serving.port !== null && (
        <Card title="Cloudflare key not on this computer">
          <p className="hint">
            The till cannot upload the shop's copy for when it is off, so phones keep the last one the old
            main sent. Copy <code>%USERPROFILE%\.shopos\cloudflare.env</code> from the PC that was the main
            to the same place on this one, then restart the till.
          </p>
        </Card>
      )}

      {photoNotHere.length > 0 && (
        <Card title={`Photos not on this computer (${photoNotHere.length})`}>
          <p className="hint">
            These were added on another till, most likely the one that was the main before. Photos travel as
            a name only, so their files stayed there. Phones still see any Cloudflare already has; add them
            again here (Inventory, open the item, Photo for the storefront) to be sure.
          </p>
          <p>{photoNotHere.slice(0, 60).join(' · ')}{photoNotHere.length > 60 ? ` and ${photoNotHere.length - 60} more` : ''}</p>
        </Card>
      )}

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
          label="Opening hours"
          hint="Shown on the storefront, as you write it: “9 am to 9 pm, closed Sunday”. The address and phone come from Shop details."
          value={settings.hours ?? ''}
          onSave={(v) => save({ hours: v || null })}
        />
        <TextSetting
          label="Turn away unanswered orders after (minutes)"
          hint={'0 keeps an order waiting until somebody accepts or turns it away. Any other number turns '
            + 'away an order nobody has answered in that many minutes.'}
          value={String(settings.answerMinutes)}
          onSave={(v) => {
            const n = Number(v)
            if (Number.isInteger(n) && n >= 0) void save({ answerMinutes: n })
          }}
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
