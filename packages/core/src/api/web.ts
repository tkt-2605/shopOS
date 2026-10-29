/*
 * @shopos/core/web -- Orders from the storefront: what it lists, who signed in, and the orders themselves.
 *
 * One of the areas core is published in (`package.json` exports). A caller
 * that needs only this area imports it here; `@shopos/core` is every area at
 * once and stays for the callers that want that. Re-exports only: nothing is
 * defined in a barrel (`architecture.test.ts`).
 */

export {
  ONLINE_ORDER_SHOPS, WEB_SETTINGS, loadWebSettings, saveWebSettings, isOnlineOrderShop, whyNotServing, onlineOrdersAllowed,
  answersOnlineOrders, whatsappNumber,
} from '../services/web/gate.js'
export type { WebSettings, WebRefusal } from '../services/web/gate.js'
export {
  buildCatalog, publishCatalog, listedCategoryIds, isListed, shelfPricer, shelfPrice,
} from '../services/web/catalog.js'
export type {
  Catalog, CatalogItem, CatalogUnit, CatalogTier, CatalogCategory, PublishedCatalog, ShelfPricer,
} from '../services/web/catalog.js'
export { verifyGoogleIdToken, parseJwks } from '../services/web/google.js'
export type { Jwk, Jwks, GoogleIdentity, GoogleVerdict } from '../services/web/google.js'
export { heldGoogleKeys, rememberGoogleKeys } from '../services/web/googleKeys.js'
export { issueSession, readSession, bearer } from '../services/web/session.js'
export type { Session } from '../services/web/session.js'
export { loadAccount, signIn, saveContact, verifyPhone, normalisePhone, blockWebAccount, signOutWebAccount } from '../services/web/accounts.js'
export type { WebAccount, SaveContactResult } from '../services/web/accounts.js'
export {
  placeOrder, acceptWebOrder, rejectWebOrder, markWebOrder, cancelWebOrder, customerCancel, expireUnanswered,
  MAX_LINES, MAX_QTY, MAX_OPEN_ORDERS, orderLabel,
} from '../services/web/orders.js'
export type { WebOrderLineInput, PlaceOrderResult, AcceptResult, AnswerResult } from '../services/web/orders.js'
export {
  loadWebOrder, ordersForAccount, orderForAccount, ordersForShop, reviewWebOrder, isOpen,
} from '../services/web/orderViews.js'
export type {
  WebOrderStatus, WebOrderLine, WebOrderView, ShopWebOrder, ShopOrderFilter, ReviewLine,
} from '../services/web/orderViews.js'
export { proposeChanges, withdrawProposal, answerProposal } from '../services/web/proposals.js'
export type { ProposedLineInput, ProposeResult } from '../services/web/proposals.js'
export type { Proposal } from '../services/web/orderViews.js'
export { productPhoto, setProductPhoto, removeProductPhoto, listedWithoutPhoto, listedPhotoFiles } from '../services/web/photos.js'
export type { ProductPhoto } from '../services/web/photos.js'
export { handleWebRequest, newThrottles, currentCatalog, republishCatalog, publicStatus, forgetServingState } from '../services/web/routes.js'
export type { WebRequest, WebReply, WebDeps, WebThrottles } from '../services/web/routes.js'
export { HourlyThrottle } from '../services/web/throttle.js'
