import { useCallback, useEffect, useState } from 'react'
import {
  entitlement, installToken, removeToken, storedToken,
  UNLICENSED, type Entitlement, type Grant,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { deviceStore } from '../core/device'
import {
  licenceLine, clockLine, installProblem, tierName, grantLine, type LicenceLine,
} from '../core/licenceWords'
import { copyText } from '../core/clipboard'
import { saveFile } from '../core/exportFile'
import { Card, Field, Alert } from './components'
import { useConfirm } from './useConfirm'

/**
 * The shop's licence: what it is, and how a code gets in and out.
 *
 * Until this existed, a licence could only reach a till by somebody editing a
 * `settings` row by hand — so everything underneath it was built, tested, and
 * unreachable. This is the whole of the product's paid side as far as a
 * shopkeeper is concerned.
 *
 * ## In and out, both
 *
 * **In** is the obvious half: paste a code, and `installToken` decides.
 *
 * **Out** matters more than it looks. A licence replicates between tills, so
 * normally nobody needs to carry one — but the shop with sync down, the till
 * being set up before it has paired, and the support call that begins "can you
 * send me your licence code" all need the code back out of a machine that has
 * it. A card that can only swallow codes turns each of those into a database
 * question.
 *
 * ## The shop id, which has to be here
 *
 * A licence is issued to one shop, and `portal issue --shop <id>` needs that
 * id before a code can exist at all. It is minted once in `bootstrap.ts` and
 * read in five places in the code — and until this card showed it, in none on
 * screen. Which meant selling a licence to a real shop began with somebody
 * remoting in to read a `settings` row.
 *
 * So it is shown **always**, including with no licence installed. That is
 * precisely the moment it is needed: before anything has been bought.
 *
 * ## What it never does
 *
 * It does not gate anything. There is no state of this card in which the
 * counter stops working, and the sentences in `licenceWords.ts` say so out
 * loud in every message about lapsing — because a shopkeeper who reads
 * "expired" and closes the till for the afternoon has lost a day's takings to
 * a word.
 */

export function LicenceCard() {
  const { db, user } = useCore()
  const [confirmUi, ask] = useConfirm()

  const [state, setState] = useState<Entitlement>(UNLICENSED)
  const [code, setCode] = useState<string | null>(null)
  const [shopId, setShopId] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<LicenceLine | null>(null)
  const [said, setSaid] = useState('')

  const reload = useCallback(async () => {
    /* With the device store, so `clockUnreliable` is actually computed. Without
       it the answer is hard-false and `clockLine` below can never say anything
       — which is what this card did until the witness was wired up. */
    setState(await entitlement(db, { device: deviceStore() }))
    const held = await storedToken(db)
    /* The stored string, not the parsed token: what a person has to paste
       somewhere else is the code exactly as it arrived. */
    setCode(held === null ? null : (await rawToken(db)))
    setShopId(await shopIdOf(db))
  }, [db])

  useEffect(() => { void reload() }, [reload])

  /** A one-line acknowledgement that fades rather than a dialog to dismiss. */
  const say = useCallback((words: string) => {
    setSaid(words)
    setTimeout(() => setSaid(''), 4000)
  }, [])

  const install = useCallback(async () => {
    const raw = typed.trim()
    if (raw === '') return

    setBusy(true)
    setFailed(null)
    try {
      const result = await installToken(db, { actorId: user?.id ?? null }, raw)
      if (result.ok) {
        setTyped('')
        await reload()
        say('Licence saved.')
      } else {
        setFailed(installProblem(result.code, result.shopId))
      }
    } finally {
      setBusy(false)
    }
  }, [db, typed, user, reload, say])

  const copy = useCallback(async () => {
    if (code === null) return
    say(await copyText(code) ? 'Code copied.' : 'Could not reach the clipboard.')
  }, [code, say])

  const save = useCallback(async () => {
    if (code === null) return
    const result = await saveFile('shopos-licence.txt', code)
    say(result.ok ? `Saved to ${result.path}` : result.message)
  }, [code, say])

  const copyOne = useCallback(async (grant: Grant) => {
    say(await copyText(grant.raw) ? 'Code copied.' : 'Could not reach the clipboard.')
  }, [say])

  const copyId = useCallback(async () => {
    if (shopId === null) return
    say(await copyText(shopId) ? 'Shop id copied.' : 'Could not reach the clipboard.')
  }, [shopId, say])

  const saveId = useCallback(async () => {
    if (shopId === null) return
    /* A file as well as the clipboard, because the machine that has the id is
       often not the machine the message gets sent from. */
    const result = await saveFile('shopos-shop-id.txt', shopId)
    say(result.ok ? `Saved to ${result.path}` : result.message)
  }, [shopId, say])

  const remove = useCallback(async (grant: Grant) => {
    const yes = await ask({
      title: `Remove the ${tierName(grant.tier).toLowerCase()} code?`,
      /* Names the one being removed, because a shop can hold more than one and
         "remove this licence" beside a list of two says nothing about which. */
      message: 'The counter is unaffected — billing, printing and backups all carry '
        + 'on. Only what this code paid for stops, and only until it is pasted '
        + 'again. Any other code on this till is untouched.',
      confirmLabel: 'Remove it',
    })
    if (!yes) return
    await removeToken(db, { actorId: user?.id ?? null }, grant.raw)
    await reload()
    say('Licence removed.')
  }, [db, user, ask, reload, say])

  const line = licenceLine(state)
  const clock = clockLine(state)

  return (
    <Card title="Licence">
      {confirmUi}

      <Alert kind={line.tone}>
        <strong>{line.headline}</strong>
        {line.detail !== '' && <div>{line.detail}</div>}
      </Alert>

      {clock !== '' && <Alert kind="warn">{clock}</Alert>}

      <Field
        label="This shop's id"
        hint="Tell us this when you buy or renew a licence. A licence is issued to one shop."
      >
        {shopId === null ? (
          /* A real state, not a bug: `sync.ts` lets a till with no shop id join
             any shop, so a till part-way through setting up has not got one.
             Saying so beats an empty box somebody reads as broken. */
          <div className="hint">Not set up yet — finish setting up this till first.</div>
        ) : (
          <>
            <input
              readOnly
              value={shopId}
              className="num"
              aria-label="This shop's id"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button type="button" className="btn" onClick={() => { void copyId() }}>
                Copy the id
              </button>
              <button type="button" className="btn" onClick={() => { void saveId() }}>
                Save the id to a file
              </button>
            </div>
          </>
        )}
      </Field>

      {state.grants.length > 0 && (
        <Field
          label={state.grants.length === 1 ? 'What this shop has' : 'What this shop has bought'}
          hint="Each code is one thing bought. They are kept separately because they
                do not all run out at the same time — some never do."
        >
          {state.grants.map((grant) => (
            <div
              key={grant.raw}
              className="row"
              style={{ gap: 12, alignItems: 'baseline', marginBottom: 10 }}
            >
              <div style={{ minWidth: 140 }}><strong>{tierName(grant.tier)}</strong></div>
              {/* The sentence only when there is more than one. With a single
                  licence the alert above has already said it, and the same
                  words twice on one card reads as a mistake. */}
              <div className="hint" style={{ flex: 1 }}>
                {state.grants.length > 1 ? grantLine(grant) : ''}
              </div>
              <button type="button" className="btn" onClick={() => { void copyOne(grant) }}>
                Copy
              </button>
              <button
                type="button"
                className="btn ghost"
                aria-label={`Remove the ${tierName(grant.tier)} code`}
                onClick={() => { void remove(grant) }}
              >
                Remove
              </button>
            </div>
          ))}
        </Field>
      )}

      {code !== null && (
        <Field
          label={state.grants.length > 1 ? 'All of them, as one block' : "This shop's code"}
          hint="Needed to set up another counter while sync is down, or if we ask for it."
        >
          <textarea
            readOnly
            value={code}
            rows={3}
            aria-label="This shop's licence code"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="btn" onClick={() => { void copy() }}>
              Copy all
            </button>
            <button type="button" className="btn" onClick={() => { void save() }}>
              Save to a file
            </button>
          </div>
        </Field>
      )}

      <Field
        label="Paste a licence code"
        hint="Added to what is already here. A renewal replaces the one it renews;
              anything else is kept alongside."
      >
        <textarea
          value={typed}
          rows={3}
          spellCheck={false}
          aria-label="Paste a licence code"
          placeholder="Paste the whole code, including the dot in the middle"
          onChange={(e) => { setTyped(e.target.value); setFailed(null) }}
        />
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="btn primary"
            disabled={busy || typed.trim() === ''}
            onClick={() => { void install() }}
          >
            {busy ? 'Checking…' : 'Save this code'}
          </button>
          {said !== '' && <span className="hint" role="status">{said}</span>}
        </div>
      </Field>

      {failed !== null && (
        <Alert kind={failed.tone}>
          <strong>{failed.headline}</strong>
          {failed.detail !== '' && <div>{failed.detail}</div>}
        </Alert>
      )}
    </Card>
  )
}

/**
 * The code exactly as it was pasted.
 *
 * `storedToken` parses, which is right for the fields above and wrong for the
 * box a person copies out of: re-encoding a token would produce a different
 * string with the same meaning, and the signature is over the original bytes.
 * So the raw setting is read directly.
 */
async function rawToken(db: Parameters<typeof entitlement>[0]): Promise<string | null> {
  const row = await db.get<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?', ['licence_token'],
  )
  return row?.value ?? null
}

/** Which shop this is, as `portal issue --shop` and the licence both mean it. */
async function shopIdOf(db: Parameters<typeof entitlement>[0]): Promise<string | null> {
  const row = await db.get<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?', ['shop_id'],
  )
  return row?.value ?? null
}
