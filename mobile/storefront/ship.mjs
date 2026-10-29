/*
 * Ships a storefront change everywhere at once, so the website, the installed
 * PWA and the Android app never show two different shops:
 *
 *   1. tests (apps/storefront), stopping on a failure;
 *   2. the Android app (build-apk.mjs), which also builds the site with the live API;
 *   3. a check that the built site talks to the live API and not a test address;
 *   4. the site to Cloudflare Pages (shop.thiruvengadam.me) with its /data
 *      function, which every browser and PWA picks up on its next open.
 *
 *   node mobile/storefront/ship.mjs
 */
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const api = 'https://api-shop.thiruvengadam.me'
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, SHOP_API: api } })

run('npx vitest run --project storefront')
run('node build-apk.mjs', here)

const assets = join(root, 'apps', 'storefront', 'dist', 'assets')
const live = readdirSync(assets).filter((f) => f.endsWith('.js')).some((f) => readFileSync(join(assets, f), 'utf8').includes(api))
if (!live) throw new Error(`The built site does not point at ${api}. Not deploying.`)

/* From apps/storefront, so wrangler.toml binds the KV store and functions/ (the /data routes) go up too. */
run('npx wrangler@4.40.0 pages deploy --project-name shopos-shop --branch main', join(root, 'apps', 'storefront'))
console.log(`\nShipped: the site is live, and the app is at ${join(here, 'StoreFront.apk')}`)
