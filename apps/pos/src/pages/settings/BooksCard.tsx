import { useEffect, useState } from 'react'
/* From the two areas this card uses, rather than the whole of core (see `packages/core/src/api`). */
import { booksClosedThrough, closeBooks } from '@shopos/core/books'
import { businessDate, addDays } from '@shopos/core/foundation'
import { useCore, useUser } from '../../core/CoreProvider'
import { Card, Field, Alert } from '../../ui/components'
import { Group } from './parts'

/**
 * Books closed through a date.
 *
 * Set once a month's GST return is filed. After it, nothing dated on or before
 * that day can be cancelled or posted -- a mistake found later is put right by a
 * document dated today. The counter keeps billing whatever is set here.
 */
export function BooksCard() {
  const { db } = useCore()
  const user = useUser()
  const [through, setThrough] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)

  useEffect(() => {
    /* Caught, as every read a screen starts is: a promise nobody handles is an
       error nobody sees, and it failed the release build of 0.2.0. */
    booksClosedThrough(db)
      .then((value) => {
        setThrough(value)
        setTyped(value ?? '')
      })
      .catch((err: unknown) => {
        setError(`The closed date could not be read: ${err instanceof Error ? err.message : String(err)}`)
      })
  }, [db])

  async function save(next: string | null) {
    setError(null)
    setSaid(null)
    let result: Awaited<ReturnType<typeof closeBooks>>
    try {
      result = await closeBooks(db, { through: next, actorId: user.id })
    } catch (err) {
      // Refused by the service (a role without the right) or by the database.
      setError(`That did not go through: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!result.ok) {
      setError(result.code === 'NOT_BEFORE_TODAY'
        ? `Only days before today (${result.today}) can be closed. Today is still being traded.`
        : 'That is not a date.')
      return
    }
    setThrough(result.closedThrough)
    setTyped(result.closedThrough ?? '')
    setSaid(result.closedThrough === null
      ? 'Every period is open again.'
      : `Closed through ${result.closedThrough}.`)
  }

  return (
    <Card title="Filed returns">
      <Group
        title="Books closed through"
        why={
          'Once a month’s GSTR-1 is filed, the bills in it are what was filed. Closing the books through '
          + 'the last day of that month stops anything dated on or before it being cancelled or posted, '
          + 'so the figures cannot move under a return that has gone in. A mistake found afterwards is '
          + 'corrected by a credit note or a stock adjustment dated today. Billing is never stopped by this.'
        }
      >
        {error && <div style={{ marginBottom: 9 }}><Alert>{error}</Alert></div>}
        {said && <div style={{ marginBottom: 9 }}><Alert kind="ok">{said}</Alert></div>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Closed through" hint={through === null ? 'Nothing is closed.' : undefined}>
            <input
              className="input"
              type="date"
              value={typed}
              max={addDays(businessDate(), -1)}
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>
          <button
            className="btn primary sm"
            type="button"
            disabled={typed === '' || typed === through}
            onClick={() => void save(typed)}
          >
            Close the books
          </button>
          {through !== null && (
            <button className="btn ghost sm" type="button" onClick={() => void save(null)}>
              Reopen everything
            </button>
          )}
        </div>
      </Group>
    </Card>
  )
}
