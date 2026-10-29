import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { Money } from '../../money.js'
import { fromUnits } from '../../quantity.js'
import { requirePermission } from '../../integrity/permissions.js'
import { writeAudit } from '../../integrity/audit.js'
import { isListed, listedCategoryIds, shelfPrice, shelfPricer } from './catalog.js'
import { answersOnlineOrders } from './gate.js'
import { hasUnit, MAX_LINES, MAX_QTY, withBrand } from './orders.js'
import { loadWebOrder, orderForAccount, type WebOrderLine, type WebOrderView } from './orderViews.js'

/*
 * An order the shop changes and sends back.
 *
 * Out of the blue pens, so two black instead; only six of the ten notebooks.
 * Rather than turning the order away, the person at the main sends the
 * customer a changed list with a note. The customer sees what changed and
 * takes it or cancels. Taking it puts the changed lines in place and hands the
 * order back to the shop, waiting, to accept as any other -- the shop still
 * answers last, because only a person at the main raises a sales order.
 *
 * Until the customer answers, the order waits on them: the shop cannot accept
 * it (`AWAITING_CUSTOMER`), it is never turned away for want of an answer, and
 * the lines they first asked for stay as they were. The shop can take the
 * proposal back, or send another in its place.
 */

export interface ProposedLineInput {
  productId: string
  unit: string
  qty: number
}

export type ProposeResult =
  | { ok: true; order: WebOrderView }
  | { ok: false; code: 'NOT_THE_MAIN' | 'NOT_FOUND' | 'NOT_PENDING' | 'NO_LINES' | 'TOO_MANY_LINES' | 'BAD_LINE' | 'NO_CHANGE' }
  | { ok: false; code: 'NOT_LISTED'; productId: string }

/**
 * The changed list, priced for the customer as the storefront would price it
 * at that quantity, so what they are asked to agree to is what the counter
 * will charge.
 */
export async function proposeChanges(
  db: SqlDriver,
  input: { webOrderId: string; actorId: string; lines: ProposedLineInput[]; note?: string | null; now?: Date },
): Promise<ProposeResult> {
  await requirePermission(db, input.actorId, 'document', 'create')
  if (!await answersOnlineOrders(db)) return { ok: false, code: 'NOT_THE_MAIN' }
  const order = await loadWebOrder(db, input.webOrderId)
  if (!order) return { ok: false, code: 'NOT_FOUND' }
  if (order.status !== 'pending') return { ok: false, code: 'NOT_PENDING' }

  const wanted = input.lines.filter((l) => l.qty !== 0)
  if (wanted.length === 0) return { ok: false, code: 'NO_LINES' }
  if (wanted.length > MAX_LINES) return { ok: false, code: 'TOO_MANY_LINES' }

  const now = input.now ?? new Date()
  const categories = await listedCategoryIds(db)
  const pricer = await shelfPricer(db)
  const lines: WebOrderLine[] = []
  for (const line of wanted) {
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) return { ok: false, code: 'BAD_LINE' }
    const [product] = await q(db)
      .select({ name: schema.products.name, brand: schema.products.brand, baseUnit: schema.products.baseUnit })
      .from(schema.products).where(eq(schema.products.id, line.productId))
    if (!product) return { ok: false, code: 'BAD_LINE' }
    /* Something already on the order may stay even if it has since come off the
       list; anything new must be something the storefront sells. */
    const already = order.lines.some((l) => l.productId === line.productId)
    if (!already && !await isListed(db, line.productId, categories)) return { ok: false, code: 'NOT_LISTED', productId: line.productId }
    const base = line.unit === product.baseUnit
    if (!base && !await hasUnit(db, line.productId, line.unit)) return { ok: false, code: 'BAD_LINE' }
    const s = await shelfPrice(db, pricer, line.productId, base ? null : line.unit, now, fromUnits(line.qty))
    lines.push({ productId: line.productId, name: withBrand(product.name, product.brand), unit: line.unit, qty: line.qty, seenPrice: s.price })
  }

  const same = lines.length === order.lines.length
    && lines.every((l, i) => order.lines[i]?.productId === l.productId && order.lines[i]?.unit === l.unit
      && order.lines[i]?.qty === l.qty)
  /* Asked with no price shown (prices on request): the same items, priced, are the quotation. */
  const quoting = order.seenTotal === 0
  if (same && !quoting) return { ok: false, code: 'NO_CHANGE' }

  const at = now.toISOString()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.webOrders).set({
      proposedJson: JSON.stringify(lines),
      proposalNote: input.note?.trim().slice(0, 300) || null,
      proposedAt: at,
      proposedBy: input.actorId,
      updatedAt: at,
    }).where(eq(schema.webOrders.id, order.id))
    await writeAudit(tx, { actorId: input.actorId, now: () => at }, {
      entity: 'web_orders', entityId: order.id, action: 'update', after: { proposed: lines.length },
    })
  })
  return { ok: true, order: (await loadWebOrder(db, order.id))! }
}

/** The shop takes its changes back; the order waits for the shop again, as the customer asked it. */
export async function withdrawProposal(
  db: SqlDriver, input: { webOrderId: string; actorId: string; now?: Date },
): Promise<{ ok: true } | { ok: false; code: 'NOT_THE_MAIN' | 'NOT_FOUND' | 'NOTHING_SENT' }> {
  await requirePermission(db, input.actorId, 'document', 'create')
  if (!await answersOnlineOrders(db)) return { ok: false, code: 'NOT_THE_MAIN' }
  const order = await loadWebOrder(db, input.webOrderId)
  if (!order) return { ok: false, code: 'NOT_FOUND' }
  if (order.proposal === null) return { ok: false, code: 'NOTHING_SENT' }
  await clearProposal(db, order.id, (input.now ?? new Date()).toISOString())
  return { ok: true }
}

/**
 * The customer's answer. Taking the changes puts them in place -- the lines,
 * and the total they now expect -- and returns the order to the shop to
 * accept. Refusing them cancels the order: the shop has said it cannot fill
 * the first list.
 */
export async function answerProposal(
  db: SqlDriver, input: { accountId: string; orderId: string; take: boolean; now: Date },
): Promise<{ ok: true; order: WebOrderView } | { ok: false; code: 'NOT_FOUND' | 'NOTHING_SENT' }> {
  const order = await orderForAccount(db, input.accountId, input.orderId)
  if (!order) return { ok: false, code: 'NOT_FOUND' }
  if (order.proposal === null) return { ok: false, code: 'NOTHING_SENT' }
  const at = input.now.toISOString()
  const proposal = order.proposal
  await db.transaction(async (tx) => {
    if (input.take) {
      await q(tx).update(schema.webOrders).set({
        linesJson: JSON.stringify(proposal.lines),
        seenTotal: proposal.total as Money,
        agreedAt: at,
        proposedJson: null, proposalNote: null, proposedAt: null, proposedBy: null,
        updatedAt: at,
      }).where(eq(schema.webOrders.id, order.id))
    } else {
      await q(tx).update(schema.webOrders).set({
        status: 'cancelled',
        reason: 'The customer did not take the changes',
        answeredAt: at,
        proposedJson: null, proposalNote: null, proposedAt: null, proposedBy: null,
        updatedAt: at,
      }).where(eq(schema.webOrders.id, order.id))
    }
  })
  return { ok: true, order: (await loadWebOrder(db, order.id))! }
}

async function clearProposal(db: SqlDriver, id: string, at: string): Promise<void> {
  await q(db).update(schema.webOrders).set({
    proposedJson: null, proposalNote: null, proposedAt: null, proposedBy: null, updatedAt: at,
  }).where(eq(schema.webOrders.id, id))
}
