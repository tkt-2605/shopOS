import { createServer, type Server, type ServerResponse } from 'node:http'
import type { Till } from './till.js'

/**
 * The buttons, without a screen.
 *
 * In the app, a person pairs two tills by pressing "Offer a code" on one and
 * typing it into the other, and syncs by pressing sync or waiting for the loop.
 * A till in a container has nobody to press anything, so Layer 2 needs a way to
 * ask it to do those same three things from outside the process.
 *
 * This is that, and deliberately nothing more: offer a code, join with one,
 * sync with a peer, and say how many rows you hold. Each maps one-to-one onto
 * something a shopkeeper can already do, so a scenario driven through here is
 * a scenario a person could have driven by hand.
 *
 * ## Bound to loopback, always
 *
 * It is an unauthenticated way to make a till pair with an arbitrary address,
 * which on any interface but this one would be a way to walk off with a shop's
 * database. `127.0.0.1` is not a default here, it is the only option — the
 * container's own `run.sh` reaches it through `docker compose exec`, from
 * inside, and nothing outside the container can route to it.
 *
 * It is not compiled into the app: `apps/pos` never imports this package.
 */

export interface Control {
  port: number
  stop(): Promise<void>
}

type Handler = (body: Record<string, unknown>) => Promise<unknown>

export async function startControl(till: Till, port: number): Promise<Control> {
  const routes: Record<string, Handler> = {
    /** Offer a pairing code, as the till that already has the shop. */
    '/control/offer': async () => {
      const { offerPairing } = await import('@shopos/core')
      return { code: await till.as(async () => offerPairing()) }
    },

    /** Join a shop, with a code read off the other till. */
    '/control/pair': async (body) => {
      const url = String(body['url'] ?? '')
      const code = String(body['code'] ?? '')
      if (!url || !code) throw new Error('url and code are required')
      const { pairWith } = await import('@shopos/core')
      const outcome = await till.as(() =>
        pairWith(till.db, url, code, till.label, fetch, { listenPort: till.port }))
      return { ok: true, peer: outcome.deviceId, shopId: outcome.shopId }
    },

    /**
     * Start a sync with a peer already paired. **This** till initiates, which
     * is the direction the host-till bug broke and the reason Layer 2 runs it
     * again across real network namespaces.
     */
    '/control/sync': async (body) => {
      const deviceId = String(body['deviceId'] ?? '')
      if (!deviceId) throw new Error('deviceId is required')
      return till.syncWithPeer(deviceId)
    },

    /** Take a counter of this till's own, after it has the shop. */
    '/control/claim-register': async () => ({ registerId: await till.claimRegister() }),

    /** What this till holds, for an assertion on stored rows rather than a return value. */
    '/control/count': async (body) => {
      const table = String(body['table'] ?? 'bills')
      if (!/^[a-z_]+$/.test(table)) throw new Error('not a table name')
      const row = await till.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
      return { table, count: row?.n ?? 0 }
    },

    /** Who this till thinks the main is, and what that makes it. */
    '/control/role': async () => {
      const { mainTill, tillRole } = await import('@shopos/core')
      return till.as(async () => ({ role: await tillRole(till.db), main: (await mainTill(till.db)).device }))
    },

    /**
     * Goods in, through a real stock entry, of the one item the soak sells.
     * The item is made here the first time, on the till that is asked -- the
     * main, so it reaches every counter by sync like anything a shop adds.
     */
    '/control/stock-in': async (body) => {
      const units = Number(body['units'] ?? 1000)
      const { createStockEntry, submitStockEntry, Quantity, Money } = await import('@shopos/core')
      return till.as(async () => {
        const actor = await actorOf(till)
        const now = new Date().toISOString()
        await till.db.execute(
          `INSERT OR IGNORE INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
           VALUES (?, 'Soak item', 10000, 0, ?, ?)`,
          [SOAK_ITEM, now, now],
        )
        const entry = await createStockEntry(till.db, {
          entryType: 'purchase',
          lines: [{ productId: SOAK_ITEM, qty: Quantity.fromUnits(units), unitCost: Money.rupees(60) }],
          actorId: actor,
        })
        if (!entry.ok) return entry
        return submitStockEntry(till.db, { entryId: entry.entryId, actorId: actor })
      })
    },

    /**
     * A sale the way a counter makes one: a cart, then submitted with cash.
     * The number comes from the counter's series, the stock goes out through
     * the stock ledger and the money through the general ledger -- the three
     * things a raw `INSERT INTO bills` skips and a soak has to exercise.
     */
    '/control/sell': async (body) => {
      const units = Number(body['units'] ?? 1)
      /* `times` rings the same sale up that many times in one request: a day's
         trade for a catch-up test, without a round trip a bill. */
      const times = Math.max(1, Number(body['times'] ?? 1))
      const { createBill, submitBill, Quantity } = await import('@shopos/core')
      return till.as(async () => {
        if (till.registerId === null) return { ok: false, code: 'NO_COUNTER' }
        const actor = await actorOf(till)
        let last: unknown = null
        for (let i = 0; i < times; i += 1) {
          const draft = await createBill(till.db, {
            registerId: till.registerId,
            lines: [{ productId: SOAK_ITEM, qty: Quantity.fromUnits(units) }],
            actorId: actor,
          })
          if (!draft.ok) return { ...draft, sold: i }
          const done = await submitBill(till.db, {
            billId: draft.billId,
            payments: [{ method: 'cash', amount: draft.grandTotal }],
            actorId: actor,
          })
          if (!done.ok) return { ...done, sold: i }
          last = done.docNo
        }
        return { ok: true, docNo: last, sold: times }
      })
    },

    /** Cancels this counter's newest bill that still stands. */
    '/control/cancel': async () => {
      const { cancelBill } = await import('@shopos/core')
      return till.as(async () => {
        const bill = await till.db.get<{ id: string; doc_no: string }>(
          `SELECT id, doc_no FROM bills WHERE register_id = ? AND docstatus = 1
           ORDER BY created_at DESC LIMIT 1`,
          [till.registerId],
        )
        if (bill === undefined) return { ok: false, code: 'NOTHING_TO_CANCEL' }
        const done = await cancelBill(till.db, { billId: bill.id, reason: 'soak', actorId: await actorOf(till) })
        return { ...done, docNo: bill.doc_no }
      })
    },

    /** Every replicated row this till holds, for comparing with the others. */
    '/control/dump': async () => {
      const { contents, heldToJson } = await import('./books.js')
      return heldToJson(await contents(till.db))
    },

    /** This till's books checked against themselves. See `books.ts`. */
    '/control/health': async () => {
      const { health } = await import('./books.js')
      return health(till.db)
    },

    /** One bill, so there is something for a sync to carry. */
    '/control/bill': async (body) => {
      const docNo = String(body['docNo'] ?? '')
      if (!docNo) throw new Error('docNo is required')
      return { id: await till.writeBill(docNo) }
    },
  }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += String(chunk) })
    req.on('end', () => {
      void (async () => {
        const route = routes[req.url ?? '']
        if (!route) {
          reply(res, 404, { error: 'no such control' })
          return
        }
        try {
          const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
          reply(res, 200, await route(body))
        } catch (err) {
          reply(res, 500, { error: String(err) })
        }
      })()
    })
  })

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    stop: () => new Promise<void>((resolve) => (server as Server).close(() => resolve())),
  }
}

/** The one item a soak stocks and sells. Fixed, so every till names it alike. */
const SOAK_ITEM = 'soak-item-0000-4000-8000-000000000001'

/** Who the bench bills as: the shop's administrator, which every till has once synced. */
async function actorOf(till: Till): Promise<string> {
  const user = await till.db.get<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`)
  if (user === undefined) throw new Error('this till has no user to act as; sync first')
  return user.id
}

/** Length declared, for the same reason `till.ts` does it. */
function reply(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
