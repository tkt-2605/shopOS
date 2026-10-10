import { useCallback, useEffect, useState } from 'react'
import {
  allowsAny, entitlement, getSetting, installToken, removeToken, storedCodes,
  UNLICENSED, type Entitlement, type Grant,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { deviceStore } from '../core/device'
import {
  licenceLine, clockLine, installProblem, tierName, grantLine, stateWord,
  FEATURES, planFor, type LicenceLine, type FeatureWords,
} from '../core/licenceWords'
import { copyText } from '../core/clipboard'
import { saveFile } from '../core/exportFile'
import { Card, Alert } from './components'
import { useConfirm } from './useConfirm'

/**
 * The shop's licence: what it has, what that includes, and how a code gets in
 * and out.
 *
 * Read top to bottom the way a shopkeeper asks: which plan am I on, what does
 * it give me, what have I bought. The codes themselves are long signed
 * strings nobody reads, so they stay folded away until somebody needs to move
 * one -- the shop with sync down, the till being set up before it has paired,
 * the support call that asks for it.
 *
 * The shop id is shown **always**, including with no licence installed,
 * because that is the moment it is needed: `portal issue --shop <id>` cannot
 * make a code without it.
 *
 * It gates nothing. There is no state of this card in which the counter stops
 * working, and the free rows in the list say so without a paragraph.
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
    /* With the device store, so `clockUnreliable` is actually computed. */
    setState(await entitlement(db, { device: deviceStore() }))
    /* The codes exactly as they were pasted, not re-encoded: the signature is
       over the original bytes, so a re-encoded token would not verify. */
    const codes = await storedCodes(db)
    setCode(codes.length === 0 ? null : codes.join('\n'))
    setShopId(await getSetting(db, 'shop_id'))
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
        setFailed(installProblem(result.code, result.shopId, result.cause))
      }
    } finally {
      setBusy(false)
    }
  }, [db, typed, user, reload, say])

  const copy = useCallback(async (text: string, what: string) => {
    say(await copyText(text) ? `${what} copied.` : 'Could not reach the clipboard.')
  }, [say])

  const save = useCallback(async (filename: string, text: string) => {
    /* A file as well as the clipboard, because the machine that has the code
       is often not the machine the message gets sent from. */
    const result = await saveFile(filename, text)
    say(result.ok ? `Saved to ${result.path}` : result.message)
  }, [say])

  const remove = useCallback(async (grant: Grant) => {
    const yes = await ask({
      title: `Remove the ${tierName(grant.tier).toLowerCase()} code?`,
      /* Names the one being removed, because a shop can hold more than one. */
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
  const badge = stateWord(state)
  /* Nothing bought is not a warning. The edge goes quiet, the same as the badge. */
  const tone = state.state === 'none' && state.problem === null ? 'mute' : line.tone

  return (
    <>
      {confirmUi}

      <section className="licence-plan" data-tone={tone} aria-label="Your plan">
        <div>
          <div className="licence-kicker">Your plan</div>
          <div className="licence-plan-name">{line.headline}</div>
          {line.detail !== '' && <div className="licence-plan-detail">{line.detail}</div>}
        </div>
        <span className={`badge ${badge.tone}`}>{badge.word}</span>
      </section>

      {clock !== '' && <Alert kind="warn">{clock}</Alert>}

      <Card title="What is included">
        <ul className="licence-features">
          {FEATURES.map((feature) => (
            <Feature key={feature.name} feature={feature} grants={state.grants} />
          ))}
        </ul>
      </Card>

      {state.grants.length > 0 && (
        <Card title={state.grants.length === 1 ? 'Bought' : 'Bought, one code each'}>
          {state.grants.map((grant) => (
            <div key={grant.raw} className="licence-grant">
              <div>
                <div className="licence-grant-name">{tierName(grant.tier)}</div>
                {/* The sentence only when there is more than one. With a single
                    licence the plan above has already said it, and the same
                    words twice on one screen reads as a mistake. */}
                {state.grants.length > 1 && <div className="hint">{grantLine(grant)}</div>}
              </div>
              <div className="licence-actions">
                <button
                  type="button"
                  className="btn"
                  aria-label={`Copy the ${tierName(grant.tier)} code`}
                  onClick={() => { void copy(grant.raw, 'Code') }}
                >
                  Copy code
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
            </div>
          ))}
        </Card>
      )}

      <Card title="This shop">
        <div className="licence-id-row">
          <div>
            <div className="licence-kicker">Shop id</div>
            {shopId === null ? (
              /* A real state, not a bug: `sync.ts` lets a till with no shop id
                 join any shop, so a till part-way through setting up has none. */
              <div className="hint">Not set up yet — finish setting up this till first.</div>
            ) : (
              <input
                readOnly
                value={shopId}
                className="licence-id mono"
                aria-label="This shop's id"
                onFocus={(e) => e.currentTarget.select()}
              />
            )}
            <div className="hint">Tell us this when you buy or renew. A licence is issued to one shop.</div>
          </div>
          {shopId !== null && (
            <div className="licence-actions">
              <button type="button" className="btn" aria-label="Copy the id"
                onClick={() => { void copy(shopId, 'Shop id') }}>
                Copy
              </button>
              <button type="button" className="btn ghost" aria-label="Save the id to a file"
                onClick={() => { void save('shopos-shop-id.txt', shopId) }}>
                Save to file
              </button>
            </div>
          )}
        </div>

        <details className="licence-more" open={state.grants.length === 0 || failed !== null}>
          <summary>Add a licence code</summary>
          <div className="licence-more-body">
            <textarea
              value={typed}
              rows={3}
              spellCheck={false}
              aria-label="Paste a licence code"
              className="mono"
              placeholder="Paste the whole code, including the dot in the middle"
              onChange={(e) => { setTyped(e.target.value); setFailed(null) }}
            />
            <div className="hint">
              Added to what is already here. A renewal replaces the one it renews.
            </div>
            {failed !== null && (
              <Alert kind={failed.tone}>
                <strong>{failed.headline}</strong>
                {failed.detail !== '' && <div>{failed.detail}</div>}
              </Alert>
            )}
            <div className="licence-actions">
              <button
                type="button"
                className="btn primary"
                disabled={busy || typed.trim() === ''}
                onClick={() => { void install() }}
              >
                {busy ? 'Checking…' : 'Save this code'}
              </button>
            </div>
          </div>
        </details>

        {code !== null && (
          <details className="licence-more">
            <summary>Move this licence to another counter</summary>
            <div className="licence-more-body">
              <div className="hint">
                Counters that sync share the licence on their own. This is for one
                set up while sync is down, or when we ask for the code.
              </div>
              <textarea
                readOnly
                value={code}
                rows={3}
                className="mono"
                aria-label="This shop's licence code"
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="licence-actions">
                <button type="button" className="btn" onClick={() => { void copy(code, 'Code') }}>
                  Copy all
                </button>
                <button type="button" className="btn ghost"
                  onClick={() => { void save('shopos-licence.txt', code) }}>
                  Save to a file
                </button>
              </div>
            </div>
          </details>
        )}

        <div className="licence-said hint" role="status">{said}</div>
      </Card>
    </>
  )
}

/** One row of the list: included, not on this plan, or not built yet. */
function Feature({ feature, grants }: { feature: FeatureWords; grants: readonly Grant[] }) {
  const has = feature.gate === null || allowsAny(grants, feature.gate)
  const tag = feature.gate === null ? 'Free'
    : !feature.built ? 'Coming'
    : has ? 'Included'
    : `With ${planFor(feature.gate)}`
  const on = has && feature.built
  return (
    <li className="licence-feature" data-on={on}>
      <span className="licence-mark" aria-hidden="true">{on ? '✓' : '–'}</span>
      <span>
        <span className="settings-option-title">{feature.name}</span>
        <span className="settings-option-note">{feature.note}</span>
      </span>
      <span className={`badge ${on ? 'ok' : 'mute'}`}>{tag}</span>
    </li>
  )
}
