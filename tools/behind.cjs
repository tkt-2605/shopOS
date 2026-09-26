/**
 * How far apart the tills on this machine are, read from their live databases.
 *
 * For the three-till bench (`npm --workspace apps/pos run till:build`), where
 * each till keeps its own `%APPDATA%/com.shopos.pos.tillN/shop.db`. Read-only
 * and safe to run while they are all up, which is the point: the app shows this
 * on its own screens, and when the question is whether the *screen* is right
 * there has to be somewhere else to ask.
 *
 * That is not hypothetical. Migration 048 exists because three tills that had
 * all caught up displayed `?` — the healthiest state a shop can be in, rendered
 * as the one nothing is known about — and it took reading the rows underneath to
 * see that `their_head = 0` was being asked to mean two different things.
 *
 * `behind=?` here means no peer has ever reported a head on that row, which is
 * exactly what `head_said_at IS NULL` says and what `listPeers` reports as null.
 *
 *   node tools/behind.cjs
 */
const D = require('better-sqlite3')
const out = []
for (const n of [1, 2, 3]) {
  let db
  try { db = new D(`${process.env.APPDATA}/com.shopos.pos.till${n}/shop.db`, { readonly: true }) }
  catch { continue }
  for (const p of db.prepare(
    `SELECT device_id, their_cursor, their_head, head_said_at, last_error
       FROM sync_peers ORDER BY device_id`).all()) {
    const behind = p.head_said_at === null ? '?' : Math.max(0, p.their_head - p.their_cursor)
    out.push(`t${n}->${p.device_id.slice(0, 4)} behind=${behind}${p.last_error ? ' (unreachable)' : ''}`)
  }
  db.close()
}
console.log(out.join(' | '))
