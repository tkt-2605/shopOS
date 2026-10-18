import { useEffect, useState } from 'react'
import { saveShopProfile, stateName, STATES, type ShopProfile } from '@shopos/core'
import { useCore, useUser } from '../../core/CoreProvider'
import { Card, Field, Alert } from '../../ui/components'
import { Intro } from './parts'
import { ShopMailCard } from './ShopMailCard'

/**
 * Who the shop is, on every document it prints.
 *
 * Every field on this form was already being read by the printing code and
 * written by nothing -- the receipt builder has asked for the address, the phone
 * and the GSTIN since v1 and got null every time, because the only screen that
 * could have set them showed the signed-in user's name and stopped there.
 */
export function ShopSection({ onOpenFormat }: { onOpenFormat: (() => void) | null }) {
  const { db, shop, refreshShop } = useCore()
  const user = useUser()
  const [draft, setDraft] = useState<ShopProfile>(shop)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  // The profile arrives one tick after the provider mounts, so the form has to
  // follow it rather than snapshot whatever was there first.
  useEffect(() => { setDraft(shop) }, [shop])

  function patch(next: Partial<ShopProfile>) {
    setDraft((d) => ({ ...d, ...next }))
    setSaved(false)
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const result = await saveShopProfile(db, { actorId: user.id }, draft)
      if (!result.ok) { setError(describe(result)); return }
      await refreshShop()
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(`The details could not be saved: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Intro>
        What prints at the top of every bill, receipt and statement. Changing it
        never rewrites a document already raised — a bill keeps the address it was
        printed with.
      </Intro>

      <Card
        title="Business details"
        actions={
          <button className="btn primary sm" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        }
      >
        {error && <div style={{ marginBottom: 11 }}><Alert>{error}</Alert></div>}
        {saved && <div style={{ marginBottom: 11 }}><Alert kind="ok">Saved.</Alert></div>}

        <div className="settings-grid">
          <Field label="Shop name">
            <input className="input" id="shop-name" value={draft.name}
              onChange={(e) => patch({ name: e.target.value })} />
          </Field>
          <Field label="Phone">
            <input className="input" id="shop-phone" value={draft.phone ?? ''}
              onChange={(e) => patch({ phone: e.target.value })} />
          </Field>
          <Field label="Email" hint="Printed on documents that have room for it.">
            <input className="input" id="shop-email" value={draft.email ?? ''}
              onChange={(e) => patch({ email: e.target.value })} />
          </Field>
          <Field label="GSTIN" hint="Leave blank if the shop is not registered.">
            <input className="input num" id="shop-gstin" value={draft.gstin ?? ''}
              placeholder="33ABCDE1234F1Z5"
              onChange={(e) => patch({ gstin: e.target.value.toUpperCase() })} />
          </Field>
        </div>

        <Field label="Address">
          <textarea className="input" id="shop-address" rows={2} value={draft.address ?? ''}
            onChange={(e) => patch({ address: e.target.value })} />
        </Field>

        <Field
          label="State the shop is in"
          hint={
            'This decides the tax on every bill. Without it, a sale to a customer in '
            + 'another state is charged CGST and SGST when the law says IGST — and '
            + 'nothing on the bill would show that it was wrong.'
          }
        >
          <select className="select" id="shop-state" value={draft.stateCode ?? ''}
            onChange={(e) => patch({ stateCode: e.target.value === '' ? null : e.target.value })}>
            <option value="">Not chosen — every sale is treated as local</option>
            {STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </Field>
      </Card>

      <Card title="On the paper">
        <Field label="Small print on the receipt" hint="Shown at the bottom of every receipt and statement.">
          <input className="input" id="receipt-footer" value={draft.receiptFooter ?? ''}
            placeholder="Thank you. Goods once sold are not returnable without this bill."
            onChange={(e) => patch({ receiptFooter: e.target.value })} />
        </Field>

        {/* The A4 print path has read this since the sheet renderer was written
            and nothing has ever written it, so every invoice fell back to the
            one-line thermal footer above — which is not what terms are. */}
        <Field
          label="Terms on the A4 invoice"
          hint="Only on the sheet, which has room for them. A quotation or an order carries its own terms when one is typed on it; this is what the rest fall back to."
        >
          <textarea className="input" id="shop-terms" rows={2} value={draft.terms ?? ''}
            placeholder="Payment within 30 days. Interest at 18% per annum thereafter."
            onChange={(e) => patch({ terms: e.target.value })} />
        </Field>

        <LogoField logo={draft.logo} onChange={(logo) => patch({ logo })} onError={setError} />
        {onOpenFormat && (
          <button type="button" className="link-btn" onClick={onOpenFormat}>
            Choose what prints, and where, under Bill format →
          </button>
        )}

        <div className="settings-foot-note">
          These are saved together with the business details above.
          Signed in as <strong>{user.username}</strong> ({user.roleName}).
        </div>
      </Card>

      <ShopMailCard shopEmail={shop.email} />
    </>
  )
}

function describe(result: Extract<Awaited<ReturnType<typeof saveShopProfile>>, { ok: false }>): string {
  switch (result.code) {
    case 'NAME_REQUIRED':
      return 'The shop needs a name — it is the first line of every bill.'
    case 'BAD_GSTIN':
      return 'That is not the shape of a GSTIN. It is 15 characters: two digits, then five letters, four digits, a letter, one more character, a Z, and a last character.'
    case 'UNKNOWN_STATE':
      return 'That is not a state this software knows.'
    case 'BAD_LOGO':
      return 'That file is not an image this can print. Use a PNG, JPEG or SVG.'
    case 'LOGO_TOO_BIG':
      return `That image is ${result.kb} KB and the limit is ${result.limitKb} KB. It rides on every bill and every preview, so a smaller copy is worth making.`
    case 'GSTIN_REQUIRED':
      return 'This shop is set to charge GST, and a tax invoice has to carry the shop’s own GSTIN. Enter it here, or change the GST scheme under Tax & billing if the shop is not registered.'
    default:
      return `This GSTIN belongs to ${stateName(result.gstinState) ?? `state ${result.gstinState}`}, but the state chosen is ${stateName(result.chosenState) ?? result.chosenState}. One of the two is wrong.`
  }
}

/**
 * The shop's own mark.
 *
 * Read straight into the form as a `data:` URI rather than filed away and
 * pointed at: the bill prints from the app window and into a preview that is
 * only ever HTML, and neither can be handed a filename. Saving is what commits
 * it, like every other field -- choosing a file changes nothing until Save.
 */
function LogoField({ logo, onChange, onError }: {
  logo: string | null
  onChange: (logo: string | null) => void
  onError: (message: string | null) => void
}) {
  function choose(file: File | undefined) {
    if (!file) return
    onError(null)
    const reader = new FileReader()
    reader.onerror = () => onError('That file could not be read.')
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      /* Refused here as well as in the service, because the service's message
         arrives only on Save and the file picker is where the mistake was made. */
      if (!/^data:image\//.test(result)) {
        onError('That file is not an image this can print. Use a PNG, JPEG or SVG.')
        return
      }
      onChange(result)
    }
    reader.readAsDataURL(file)
  }

  return (
    <Field
      label="Logo"
      hint="Printed at the top of the A4 sheet, above the name. The thermal printer cannot carry a picture, so the roll prints the shop name as it always has."
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {logo && <img src={logo} alt="" className="settings-logo" />}
        <input
          type="file" id="shop-logo" accept="image/png,image/jpeg,image/svg+xml,image/webp"
          style={{ fontSize: 12.5 }}
          onChange={(e) => { choose(e.target.files?.[0]); e.target.value = '' }}
        />
        {logo && <button type="button" className="btn ghost sm" onClick={() => onChange(null)}>Remove</button>}
      </div>
    </Field>
  )
}
