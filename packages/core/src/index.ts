/*
 * Everything core publishes, area by area. Each area is also its own entry
 * point -- `@shopos/core/sales`, `@shopos/core/books` and so on -- so a caller
 * can depend on the part it uses and nothing else; see `src/api/`.
 */

export * from './api/foundation.js'
export * from './api/sync.js'
export * from './api/catalog.js'
export * from './api/sales.js'
export * from './api/stock.js'
export * from './api/books.js'
export * from './api/shop.js'
