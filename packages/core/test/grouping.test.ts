import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  listCategories, createCategory, renameCategory, removeCategory, setProductCategory,
  setVariantOf, variantFamily,
} from '../src/services/grouping.js'
import { searchProducts } from '../src/repos/catalog.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

async function category(name: string, parentId?: string): Promise<string> {
  const made = await createCategory(fx.db, ctx(), { name, ...(parentId ? { parentId } : {}) })
  if (!made.ok) throw new Error(made.code)
  return made.categoryId
}

describe('categories', () => {
  it('count what is in them', async () => {
    const stationery = await category('Stationery')
    const p = await makeProduct(fx.db, { name: 'Notebook' })
    await setProductCategory(fx.db, ctx(), p, stationery)

    const found = (await listCategories(fx.db)).find((c) => c.id === stationery)
    expect(found?.productCount).toBe(1)
  })

  it('nest one level, for a shop that wants sub-shelves', async () => {
    const drinks = await category('Cold drinks')
    const juice = await category('Juice', drinks)

    const found = (await listCategories(fx.db)).find((c) => c.id === juice)
    expect(found?.parentName).toBe('Cold drinks')
  })

  /* A category that is its own ancestor makes every list that walks upwards run
     for ever. */
  it('refuse to become their own parent', async () => {
    const one = await category('One')
    const two = await category('Two', one)

    expect((await renameCategory(fx.db, ctx(), { categoryId: one, name: 'One', parentId: one })).ok).toBe(false)
    expect((await renameCategory(fx.db, ctx(), { categoryId: one, name: 'One', parentId: two })).ok).toBe(false)
  })

  it('refuse a name another category has', async () => {
    await category('Stationery')
    const again = await createCategory(fx.db, ctx(), { name: 'stationery' })
    expect(again.ok).toBe(false)
  })

  /* Removing a category is a change to how the shop organises itself, not a
     claim that the things in it never existed. */
  it('let go of their items when retired rather than taking them away', async () => {
    const stationery = await category('Stationery')
    const p = await makeProduct(fx.db, { name: 'Notebook' })
    await setProductCategory(fx.db, ctx(), p, stationery)

    await removeCategory(fx.db, ctx(), stationery)

    expect(await listCategories(fx.db)).toHaveLength(0)
    const [product] = await searchProducts(fx.db, { term: 'Notebook' })
    expect(product?.name).toBe('Notebook')
    expect(product?.categoryId).toBeNull()
  })

  it('let a shop browse one group instead of searching', async () => {
    const drinks = await category('Cold drinks')
    const cola = await makeProduct(fx.db, { name: 'Cola' })
    await makeProduct(fx.db, { name: 'Notebook' })
    await setProductCategory(fx.db, ctx(), cola, drinks)

    const rows = await searchProducts(fx.db, { categoryId: drinks })
    expect(rows.map((r) => r.name)).toEqual(['Cola'])
    expect(rows[0]!.categoryName).toBe('Cold drinks')
  })
})

describe('versions of the same thing', () => {
  it('hang off one parent and keep their own identity', async () => {
    const pen = await makeProduct(fx.db, { name: 'Cello gel pen' })
    const blue = await makeProduct(fx.db, { name: 'Cello gel pen blue' })
    const red = await makeProduct(fx.db, { name: 'Cello gel pen red' })

    expect((await setVariantOf(fx.db, ctx(), { productId: blue, parentProductId: pen, variantLabel: 'blue' })).ok).toBe(true)
    expect((await setVariantOf(fx.db, ctx(), { productId: red, parentProductId: pen, variantLabel: 'red' })).ok).toBe(true)

    const family = await variantFamily(fx.db, blue)
    expect(family[0]!.isParent).toBe(true)
    expect(family[0]!.id).toBe(pen)
    expect(family.map((f) => f.variantLabel)).toEqual([null, 'blue', 'red'])
  })

  it('answer the same family whichever member is asked', async () => {
    const pen = await makeProduct(fx.db, { name: 'Pen' })
    const blue = await makeProduct(fx.db, { name: 'Pen blue' })
    await setVariantOf(fx.db, ctx(), { productId: blue, parentProductId: pen, variantLabel: 'blue' })

    expect(await variantFamily(fx.db, pen)).toHaveLength(2)
    expect(await variantFamily(fx.db, blue)).toHaveLength(2)
  })

  /* One level. A variant of a variant is a tree, and a tree needs a walk at
     every point that touches it. */
  it('refuse a second level', async () => {
    const pen = await makeProduct(fx.db, { name: 'Pen' })
    const blue = await makeProduct(fx.db, { name: 'Pen blue' })
    const navy = await makeProduct(fx.db, { name: 'Pen navy' })
    await setVariantOf(fx.db, ctx(), { productId: blue, parentProductId: pen, variantLabel: 'blue' })

    const result = await setVariantOf(fx.db, ctx(), { productId: navy, parentProductId: blue })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('PARENT_IS_A_VARIANT')
  })

  it('refuse to make a parent into somebody else\'s version', async () => {
    const pen = await makeProduct(fx.db, { name: 'Pen' })
    const blue = await makeProduct(fx.db, { name: 'Pen blue' })
    const other = await makeProduct(fx.db, { name: 'Something else' })
    await setVariantOf(fx.db, ctx(), { productId: blue, parentProductId: pen, variantLabel: 'blue' })

    const result = await setVariantOf(fx.db, ctx(), { productId: pen, parentProductId: other })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('HAS_VARIANTS')
  })

  it('refuse to be their own version', async () => {
    const pen = await makeProduct(fx.db, { name: 'Pen' })
    expect((await setVariantOf(fx.db, ctx(), { productId: pen, parentProductId: pen })).ok).toBe(false)
  })

  it('can be cut loose again', async () => {
    const pen = await makeProduct(fx.db, { name: 'Pen' })
    const blue = await makeProduct(fx.db, { name: 'Pen blue' })
    await setVariantOf(fx.db, ctx(), { productId: blue, parentProductId: pen, variantLabel: 'blue' })
    await setVariantOf(fx.db, ctx(), { productId: blue, parentProductId: null })

    expect(await variantFamily(fx.db, blue)).toHaveLength(1)
    const [product] = await searchProducts(fx.db, { term: 'Pen blue' })
    expect(product?.variantLabel).toBeNull()
  })
})

describe('searching a family', () => {
  /* The point of the thread between them: typing the pen's name offers all six
     colours, not only the ones whose own name repeats it. */
  it('finds a version by its parent\'s name', async () => {
    const pen = await makeProduct(fx.db, { name: 'Cello gel pen' })
    const blue = await makeProduct(fx.db, { name: 'Blue refill' })
    await setVariantOf(fx.db, ctx(), { productId: blue, parentProductId: pen, variantLabel: 'blue' })

    const rows = await searchProducts(fx.db, { term: 'Cello' })
    expect(rows.map((r) => r.name).sort()).toEqual(['Blue refill', 'Cello gel pen'])
  })

  it('sorts versions together under their parent rather than through the alphabet', async () => {
    const pen = await makeProduct(fx.db, { name: 'Mid pen' })
    const zed = await makeProduct(fx.db, { name: 'Zebra variant' })
    await makeProduct(fx.db, { name: 'Notebook' })
    await setVariantOf(fx.db, ctx(), { productId: zed, parentProductId: pen, variantLabel: 'zebra' })

    const rows = await searchProducts(fx.db, {})
    // The variant sorts by its parent's name, so it lands beside it and before
    // the notebook rather than at the end of the list.
    expect(rows.map((r) => r.name)).toEqual(['Mid pen', 'Zebra variant', 'Notebook'])
  })

  it('says which family a row belongs to', async () => {
    const pen = await makeProduct(fx.db, { name: 'Cello gel pen' })
    const blue = await makeProduct(fx.db, { name: 'Blue refill' })
    await setVariantOf(fx.db, ctx(), { productId: blue, parentProductId: pen, variantLabel: 'blue' })

    const row = (await searchProducts(fx.db, { term: 'Blue refill' }))[0]
    expect(row?.parentName).toBe('Cello gel pen')
    expect(row?.variantLabel).toBe('blue')
  })
})
