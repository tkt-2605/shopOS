import { useEffect, useState } from 'react'
import { listPeers } from '@shopos/core'
import { completeness, type Completeness as Line } from '../core/completeness'
import { useCore } from '../core/CoreProvider'
import { onSyncRound } from '../core/syncLoop'

/**
 * One line on every screen that adds up the whole shop.
 *
 * `syncStatus` lives on the Two tills card and answers whether the tills are
 * talking. That is a question about the shop's equipment. This answers whether
 * the figure above it is all of the shop's takings, which is a question about
 * the figure — and until now the screens that showed money did not ask it at
 * all. Reports, the dashboard and the cash counter each printed a total that
 * silently meant "what this machine knows about", and the tax tab is filed off
 * one of them.
 *
 * The smallest amount of code in the plan this came from, and the largest
 * consequence outside it: nothing here changes a number, and after it no number
 * is presented as more than it is.
 *
 * Renders nothing in a one-till shop. A line that is always there and always
 * says the same thing is a line people stop reading, and the one time it
 * changes is the time it needed to be read.
 */
export function Completeness() {
  const { db } = useCore()
  const [line, setLine] = useState<Line | null>(null)

  useEffect(() => {
    let alive = true
    const read = async () => {
      const said = completeness(await listPeers(db))
      if (alive) setLine(said)
    }
    void read()
    // And again after a round, because a round is exactly what changes it.
    const stop = onSyncRound(() => { void read() })
    return () => { alive = false; stop() }
  }, [db])

  if (line === null) return null

  return (
    <div
      className={line.complete ? 'completeness' : 'completeness short'}
      /* Announced, because somebody reading a total with a screen reader has
         the same right to know it is short as somebody looking at it. */
      role="status"
    >
      {line.text}
    </div>
  )
}
