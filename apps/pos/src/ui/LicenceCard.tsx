import { useCallback, useEffect, useState } from 'react'
import {
  entitlement, installToken, removeToken, storedToken,
  UNLICENSED, type Entitlement,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { licenceLine, clockLine, installProblem, prettyDate, tierName, type LicenceLine } from '../core/licenceWords'
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
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<LicenceLine | null>(null)
  const [said, setSaid] = useState('')

  const reload = useCallback(async () => {
    setState(await entitlement(db))
    const held = await storedToken(db)
    /* The stored string, not the parsed token: what a person has to paste
       somewhere else is the code exactly as it arrived. */
    setCode(held === null ? null : (await rawToken(db)))
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

  const remove = useCallback(async () => {
    const yes = await ask({
      title: 'Remove this licence code?',
      message: 'The counter is unaffected — billing, printing and backups all carry '
        + 'on. The cloud features stop until a code is pasted again.',
      confirmLabel: 'Remove it',
    })
    if (!yes) return
    await removeToken(db, { actorId: user?.id ?? null })
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

      {state.problem === null && state.state !== 'none' && (
        <div className="row" style={{ gap: 24, marginTop: 12 }}>
          <Field label="Plan"><div>{tierName(state.tier)}</div></Field>
          <Field label="Counters paid for">
            <div>{state.tills}</div>
          </Field>
          {state.paidThrough !== null && (
            <Field label={state.state === 'active' ? 'Paid to' : 'Ran out'}>
              <div>{prettyDate(state.paidThrough)}</div>
            </Field>
          )}
        </div>
      )}

      {code !== null && (
        <Field
          label="This shop's code"
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
            <button type="button" onClick={() => { void copy() }}>Copy</button>
            <button type="button" onClick={() => { void save() }}>Save to a file</button>
            <div className="spacer" />
            <button type="button" className="ghost" onClick={() => { void remove() }}>Remove</button>
          </div>
        </Field>
      )}

      <Field
        label={code === null ? 'Paste a licence code' : 'Replace it with a new code'}
        hint="Renewals arrive as a code. Pasting a newer one replaces this."
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
            className="primary"
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
