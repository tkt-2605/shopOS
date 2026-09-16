import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { rupees, type Money } from '../money.js'
import { fromUnits } from '../quantity.js'
import { bootstrap, setSetting, getSetting } from './bootstrap.js'
import { resolveCustomerState } from '../domain/gstin.js'
import { createUser } from './auth.js'
import { createStockEntry, submitStockEntry } from './stockEntry.js'

export interface FirstRunInput {
  shopName: string
  adminPassword: string
  shopStateCode?: string
  gstin?: string
  address?: string
}

export async function isFirstRun(db: SqlDriver): Promise<boolean> {
  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)
  return (row?.n ?? 0) === 0
}

export async function firstRun(db: SqlDriver, input: FirstRunInput): Promise<{ adminId: string }> {
  const seed = await bootstrap(db, { shopName: input.shopName })

  const admin = await createUser(db, {
    username: 'admin',
    password: input.adminPassword,
    fullName: 'Administrator',
    roleId: seed.roleIds['Admin']!,
  })
  if (!admin.ok) throw new Error(`could not create the administrator: ${admin.code}`)

  await setSetting(db, 'shop_state_code', input.shopStateCode ?? '33')
  if (input.gstin) await setSetting(db, 'shop_gstin', input.gstin)
  if (input.address) await setSetting(db, 'shop_address', input.address)

  return { adminId: admin.userId }
}

interface DemoProduct {
  name: string
  brand: string
  barcode: string
  rate: number
  cost: number
  taxPercent: number
  hsn: string
  stock: number
  unit?: string
}

const DEMO_PRODUCTS: DemoProduct[] = [
  { name: 'A4 Copier Paper 500 sheets', brand: 'JK', barcode: '8901234500011', rate: 340, cost: 285, taxPercent: 12, hsn: '4802', stock: 60 },
  { name: 'Ball Pen Blue', brand: 'Cello', barcode: '8901234500028', rate: 10, cost: 6.5, taxPercent: 12, hsn: '9608', stock: 500 },
  { name: 'Ball Pen Black', brand: 'Cello', barcode: '8901234500035', rate: 10, cost: 6.5, taxPercent: 12, hsn: '9608', stock: 420 },
  { name: 'Gel Pen 0.5mm', brand: 'Reynolds', barcode: '8901234500042', rate: 25, cost: 16, taxPercent: 12, hsn: '9608', stock: 260 },
  { name: 'Notebook 200 pages', brand: 'Classmate', barcode: '8901234500059', rate: 75, cost: 52, taxPercent: 12, hsn: '4820', stock: 180 },
  { name: 'Notebook 400 pages', brand: 'Classmate', barcode: '8901234500066', rate: 140, cost: 98, taxPercent: 12, hsn: '4820', stock: 95 },
  { name: 'Pencil HB', brand: 'Apsara', barcode: '8901234500073', rate: 5, cost: 3.2, taxPercent: 12, hsn: '9609', stock: 800 },
  { name: 'Eraser', brand: 'Apsara', barcode: '8901234500080', rate: 5, cost: 2.8, taxPercent: 12, hsn: '4016', stock: 350 },
  { name: 'Geometry Box', brand: 'Camlin', barcode: '8901234500097', rate: 165, cost: 118, taxPercent: 18, hsn: '9017', stock: 45 },
  { name: 'Stapler Small', brand: 'Kangaro', barcode: '8901234500103', rate: 120, cost: 82, taxPercent: 18, hsn: '8472', stock: 38 },
  { name: 'Stapler Pins 10mm', brand: 'Kangaro', barcode: '8901234500110', rate: 20, cost: 12, taxPercent: 18, hsn: '8305', stock: 220 },
  { name: 'File Folder', brand: 'Solo', barcode: '8901234500127', rate: 45, cost: 29, taxPercent: 18, hsn: '4820', stock: 140 },
  { name: 'Sticky Notes', brand: '3M', barcode: '8901234500134', rate: 85, cost: 58, taxPercent: 18, hsn: '4820', stock: 70 },
  { name: 'Whiteboard Marker', brand: 'Camlin', barcode: '8901234500141', rate: 35, cost: 22, taxPercent: 18, hsn: '9608', stock: 160 },
  { name: 'Glue Stick 15g', brand: 'Fevicol', barcode: '8901234500158', rate: 40, cost: 26, taxPercent: 18, hsn: '3506', stock: 130 },
  { name: 'Scissors 6 inch', brand: 'Nataraj', barcode: '8901234500165', rate: 90, cost: 61, taxPercent: 18, hsn: '8213', stock: 52 },
  { name: 'Calculator 12 digit', brand: 'Casio', barcode: '8901234500172', rate: 650, cost: 490, taxPercent: 18, hsn: '8470', stock: 22 },
  { name: 'Drawing Sheet A3', brand: 'Nataraj', barcode: '8901234500189', rate: 8, cost: 4.5, taxPercent: 12, hsn: '4802', stock: 600 },
  { name: 'Chart Paper', brand: 'Local', barcode: '8901234500196', rate: 15, cost: 8, taxPercent: 12, hsn: '4802', stock: 400 },
  { name: 'Envelope Pack of 50', brand: 'Solo', barcode: '8901234500202', rate: 110, cost: 74, taxPercent: 18, hsn: '4817', stock: 65 },
]

const DEMO_CUSTOMERS: { name: string; phone: string; creditLimit: number; enforcement: string; gstin?: string }[] = [
  { name: 'Walk-in', phone: '', creditLimit: 0, enforcement: 'hard' },
  { name: 'Sri Vidya School', phone: '9847112233', creditLimit: 50_000, enforcement: 'soft', gstin: '33AAACS1234F1Z5' },
  { name: 'Ramesh Traders', phone: '9847445566', creditLimit: 25_000, enforcement: 'hard', gstin: '33AABCR5678G1Z2' },
  { name: 'Lakshmi Stores', phone: '9847778899', creditLimit: 10_000, enforcement: 'soft' },
  { name: 'Anand Kumar', phone: '9847001122', creditLimit: 5_000, enforcement: 'hard' },
]

/** Demo catalogue for a stationery shop, so a fresh install opens on something real. */
export async function seedDemoData(db: SqlDriver, actorId: string): Promise<{ products: number; customers: number }> {
  const now = new Date().toISOString()

  const wholesaleId = newId()
  await db.execute(
    `INSERT INTO price_lists (id, name, is_default, created_at, updated_at) VALUES (?, 'Wholesale', 0, ?, ?)`,
    [wholesaleId, now, now],
  )

  const category = newId()
  await db.execute(`INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, 'Stationery', ?, ?)`, [category, now, now])

  const productIds: { id: string; cost: number; stock: number }[] = []

  for (const p of DEMO_PRODUCTS) {
    const id = newId()
    await db.execute(
      `INSERT INTO products
         (id, name, brand, category_id, barcode, hsn_code, tax_rate_bp, base_rate, mrp, base_unit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.name, p.brand, category, p.barcode, p.hsn, p.taxPercent * 100, rupees(p.rate), rupees(p.rate), p.unit ?? 'piece', now, now],
    )

    // The scanner reads product_barcodes, not products.barcode: a product whose
    // printed code has no row here cannot be scanned.
    await db.execute(
      `INSERT INTO product_barcodes (id, product_id, barcode, is_primary, created_at) VALUES (?, ?, ?, 1, ?)`,
      [newId(), id, p.barcode, now],
    )

    // A dozen for the pen lines, so tiered and unit pricing have something to act on.
    if (p.name.includes('Pen') || p.name.includes('Pencil')) {
      await db.execute(
        `INSERT INTO product_units (id, product_id, sale_unit, base_units, is_default, created_at, updated_at)
         VALUES (?, ?, 'dozen', ?, 0, ?, ?)`,
        [newId(), id, fromUnits(12), now, now],
      )
      await db.execute(
        `INSERT INTO item_prices (id, product_id, price_list_id, sale_unit, min_qty, rate, created_at, updated_at)
         VALUES (?, ?, ?, 'piece', ?, ?, ?, ?)`,
        [newId(), id, wholesaleId, fromUnits(50), rupees(p.rate * 0.85), now, now],
      )
    }

    productIds.push({ id, cost: p.cost, stock: p.stock })
  }

  const entry = await createStockEntry(db, {
    entryType: 'opening',
    lines: productIds.map((p) => ({
      productId: p.id,
      qty: fromUnits(p.stock),
      unitCost: rupees(p.cost) as Money,
    })),
    reference: 'Opening stock',
    actorId,
  })
  if (entry.ok) await submitStockEntry(db, { entryId: entry.entryId, actorId })

  /* Not the literal '33' this used to write. Demo data that carries a
     fabricated state is how a shop ends up believing every customer is in Tamil
     Nadu -- and it seeded the same wrong number into every install that ever
     pressed "with demo data". Derived from the demo GSTIN where there is one,
     and otherwise from whatever state the shop actually said it is in. */
  const shopState = await getSetting(db, 'shop_state_code')

  for (const c of DEMO_CUSTOMERS) {
    await db.execute(
      `INSERT INTO customers (id, name, phone, gstin, credit_limit, credit_enforcement, price_list_id, state_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(), c.name, c.phone || null, c.gstin ?? null,
        rupees(c.creditLimit), c.enforcement,
        c.name === 'Sri Vidya School' ? wholesaleId : null,
        resolveCustomerState({ gstin: c.gstin ?? null, shopState }),
        now, now,
      ],
    )
  }

  await setSetting(db, 'loyalty_program', JSON.stringify({
    enabled: true,
    tiers: [{ minSpend: 0, pointsPerHundred: 1 }, { minSpend: rupees(5000), pointsPerHundred: 2 }],
    expiryDays: 365,
    pointValue: rupees(1),
    earnOnCreditPortion: false,
    minBillForEarn: rupees(100),
    maxRedeemFractionBp: 5000,
  }))

  return { products: DEMO_PRODUCTS.length, customers: DEMO_CUSTOMERS.length }
}
