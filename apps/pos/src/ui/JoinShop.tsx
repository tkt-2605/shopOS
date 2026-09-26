import { useCallback, useEffect, useState } from 'react'
import { listRegisters, countersOtherTillsUse, type Register, type CounterTaken } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { takeCounter } from '../core/counters'
import { lookAround, type FoundTill } from '../core/syncHost'
import { explain } from '../core/syncWords'
import { Field, Alert } from './components'

/**
 * A machine becoming the shop's second till.
 *
 * On the first screen, before anything is signed in, because that is when it is
 * needed: until now the only door on a new machine was "Set up ShopOS", which
 * creates a *shop*. A second till that goes through it has made a second shop —
 * its own Admin role, its own counter, its own price list, same names, different
 * rows — and the sync handshake refuses the pair with `DIFFERENT_SHOP`, which is
 * right and arrives after a day's work is already in the wrong database.
 *
 * Nothing here calls `bootstrap`. The machine stays empty and receives the shop.
 *
 * ## Why it asks for a counter before it lets go
 *
 * A till with no counter of its own falls back to the first one in the list,
 * which is the till it just joined. Two tills on one counter mint invoice
 * numbers from the same series, so the next sync is refused with
 * `SAME_REGISTER` — recoverable in ten seconds and completely opaque if you do
 * not already know what a counter is. Asking here costs one screen and removes
 * the only refusal this flow can cause by itself.
 */

type Stage =
  | { at: 'choosing' }
  | { at: 'waiting'; requestId: string; digits: string }
  | { at: 'joining' }
  | { at: 'counter'; registers: Register[]; taken: CounterTaken[] }

export function JoinShop({ onCancel }: { onCancel: () => void }) {
  const { db, joinShop, askToJoinShop, waitToJoinShop } = useCore()
  const [stage, setStage] = useState<Stage>({ at: 'choosing' })
  const [found, setFound] = useState<FoundTill[] | null>(null)
  const [looking, setLooking] = useState(true)
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  /* The bottom rung, hidden until it is wanted. Typing a code is what this
     screen used to make everybody do; it is kept for the network that answers
     no shouts and the till that cannot be reached any other way. */
  const [typingACode, setTypingACode] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* Asked on arrival rather than behind a button. A shopkeeper setting up a
     second till is holding a machine that knows nothing; the list of tills on
     the network is the one thing the screen can offer without being asked. */
  const look = useCallback(async () => {
    setLooking(true)
    setError(null)
    try {
      const tills = await lookAround()
      setFound(tills)
      if (tills.length === 1) setAddress(tills[0]!.address)
    } catch (err) {
      setError(`Could not look for tills on this network. ${String(err)}`)
    } finally {
      setLooking(false)
    }
  }, [])

  useEffect(() => { void look() }, [look])

  /** Knocks, then waits for somebody at the other counter to press Allow. */
  async function ask() {
    setError(null)
    try {
      const asked = await askToJoinShop(address)
      if (asked.state !== 'PENDING') {
        setError('That till did not understand the request. Use a code instead.')
        return
      }
      setStage({ at: 'waiting', requestId: asked.requestId, digits: asked.digits })
    } catch (err) {
      setError(explain(err))
    }
  }

  /* Asking again every second and a half until somebody presses something. The
     wait is a person walking to the other counter, which no request timeout is
     long enough to hold a connection open for. */
  useEffect(() => {
    if (stage.at !== 'waiting') return
    let stopped = false
    /* One question at a time. A reply slower than the interval would otherwise
       overlap the next ask, and two that both came back ALLOWED arrived twice. */
    let asking = false

    const timer = setInterval(() => {
      if (asking || stopped) return
      asking = true
      void (async () => {
        try {
          const answer = await waitToJoinShop(address, stage.requestId)
          if (stopped) return
          if (answer.state === 'ALLOWED') { stopped = true; clearInterval(timer); await arrived(); return }
          /* The digits come from both tills' keys and are worked out here, so
             keep showing the latest -- the same unless the shop restarted. */
          if (answer.state === 'PENDING' && answer.digits !== stage.digits) {
            setStage({ at: 'waiting', requestId: answer.requestId, digits: answer.digits })
          }
          if (answer.state === 'REFUSED') {
            setError('That till said no.')
            setStage({ at: 'choosing' })
          }
          if (answer.state === 'LAPSED') {
            setError('The other till stopped waiting. Press "Add a till" there and try again.')
            setStage({ at: 'choosing' })
          }
        } catch (err) {
          if (!stopped) { setError(explain(err)); setStage({ at: 'choosing' }) }
        } finally {
          asking = false
        }
      })()
    }, 1500)

    return () => { stopped = true; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.at, stage.at === 'waiting' ? stage.requestId : null, address])

  /** The bottom rung: a code read off the other till's screen. */
  async function join() {
    setError(null)
    setStage({ at: 'joining' })
    try {
      await joinShop({ address, code })
      await arrived()
    } catch (err) {
      setError(explain(err))
      setStage({ at: 'choosing' })
    }
  }

  async function arrived() {
    /* The shop has arrived, so the counters are here to choose from -- and the
       first sync has run, so this till has been told which ones the others sit
       at. Those are shown and refused rather than hidden: a screen that removes
       the option is a screen that cannot explain itself, and "that one is the
       front counter's" is the explanation. */
    const [registers, taken] = await Promise.all([
      listRegisters(db),
      countersOtherTillsUse(db),
    ])
    setStage({ at: 'counter', registers, taken })
  }

  async function useCounter(id: string) {
    setError(null)
    if (!(await takeCounter(db, id))) {
      setError('This machine could not record which counter it sits at. '
        + 'It has joined the shop; open Counters after signing in and press "Use here".')
    }
    window.location.reload()
  }

  if (stage.at === 'waiting') {
    return (
      <div className="panel-body">
        <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Waiting for the other till</h2>
        <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 0 }}>
          It is asking whoever is standing there to let this machine in. Check
          these six digits match the ones on its screen before they say yes.
          If they do not, stop: something on the network is between the two tills.
        </p>
        <div style={{ fontSize: 44, letterSpacing: 8, fontWeight: 600, margin: '10px 0' }}>
          {stage.digits}
        </div>
        {error && <Alert>{error}</Alert>}
        <button className="btn ghost" onClick={() => setStage({ at: 'choosing' })}>
          Stop waiting
        </button>
      </div>
    )
  }

  if (stage.at === 'joining') {
    return (
      <div className="panel-body">
        <p style={{ fontSize: 13 }}>
          Joining, and taking a copy of the shop. On a shop with a year of trade
          behind it this takes a minute.
        </p>
      </div>
    )
  }

  if (stage.at === 'counter') {
    return (
      <div className="panel-body">
        <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Which counter is this machine?</h2>
        <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 0 }}>
          Every bill this machine prints carries its counter’s prefix, and two
          tills on one counter would give two customers the same bill number.
        </p>
        {error && <Alert>{error}</Alert>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {stage.registers.map((r) => {
            const other = stage.taken.find((t) => t.registerId === r.id)
            return (
              <button
                key={r.id}
                className="btn"
                style={{ justifyContent: 'space-between', display: 'flex' }}
                disabled={other !== undefined}
                onClick={() => void useCounter(r.id)}
              >
                <span>{r.name} — {r.prefix}</span>
                {other !== undefined
                  ? (
                    <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                      {other.label ?? 'another till'} bills here
                    </span>
                  )
                  : r.hasOpenSession && (
                    <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>a drawer is open here</span>
                  )}
              </button>
            )
          })}
        </div>
        <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 12 }}>
          {stage.registers.every((r) => stage.taken.some((t) => t.registerId === r.id))
            ? 'Every counter in this shop already has a till on it. Sign in, open '
              + 'Counters and add one for this machine — two tills on one counter '
              + 'would give two customers the same bill number.'
            : 'Nothing here for this machine? Sign in, open Counters and add one — '
              + 'this till will keep asking until it has one of its own.'}
        </p>
        {/* The shop is here either way; this is the way on when no counter
            above can be taken. Reloading opens it like any other start. */}
        <button className="btn ghost" onClick={() => window.location.reload()}>
          Sign in without choosing
        </button>
      </div>
    )
  }

  return (
    <div className="panel-body">
      {error && <Alert>{error}</Alert>}

      <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 0 }}>
        This machine will receive the shop from a till that already has it —
        staff, counters, prices and every bill. It does not set up a shop of its
        own.
      </p>

      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 12.5 }}>Tills on this network</strong>
          <button className="btn ghost sm" disabled={looking} onClick={() => void look()}>
            {looking ? 'Looking…' : 'Look again'}
          </button>
        </div>

        {found !== null && found.length === 0 && (
          <p style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
            None answered. Both machines have to be on the same network, and
            somebody has to have pressed “Add a till” on the other one — it is
            on its Settings screen, under Two tills. You can also type its
            address below.
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {(found ?? []).map((t) => (
            <button
              key={t.device}
              className={address === t.address ? 'btn primary' : 'btn'}
              style={{ display: 'flex', justifyContent: 'space-between' }}
              onClick={() => setAddress(t.address)}
            >
              <span>{t.shop ?? 'A shop'} — {t.label}</span>
              <span style={{ fontSize: 11.5, opacity: 0.8 }}>{t.address}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <Field label="Address" hint="Filled in by the list above. Type it only if nothing answered.">
          <input
            className="input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="192.168.1.11:7801"
          />
        </Field>
        {typingACode && (
          <Field
            label="Code from that till"
            hint="Shown on its Settings screen. It lasts ten minutes and one attempt uses it up."
          >
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD2345"
            />
          </Field>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        {typingACode
          ? (
            <button
              className="btn primary"
              disabled={address.trim() === '' || code.trim() === ''}
              onClick={() => void join()}
            >
              Join this shop
            </button>
          )
          : (
            <button
              className="btn primary"
              disabled={address.trim() === ''}
              onClick={() => void ask()}
            >
              Ask to join
            </button>
          )}
        <button className="btn ghost" onClick={onCancel}>Back</button>
        <span style={{ flex: 1 }} />
        <button className="link-btn" style={{ fontSize: 12 }} onClick={() => setTypingACode(!typingACode)}>
          {typingACode ? 'Ask instead' : 'Use a code instead'}
        </button>
      </div>

      <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 10 }}>
        {typingACode
          ? 'For a till that cannot be asked — press "Add a till" there and read off the code it shows.'
          : 'Somebody has to be standing at the other till to say yes. Press "Add a till" there first.'}
      </p>
    </div>
  )
}
