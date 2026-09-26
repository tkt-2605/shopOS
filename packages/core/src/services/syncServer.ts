/*
 * In pieces: `syncServer/wire.ts` is the request and the response,
 * `syncServer/pairing.ts` a new till being let in, `syncServer/serving.ts` which
 * counter this till answers as, and `syncServer/handlers.ts` the routes.
 * Re-exported here, where callers have always found them.
 */

/**
 * The side of a sync that answers.
 *
 * Deliberately not a server. It takes a request that has already arrived and
 * returns what to send back, so the thing that actually listens on a port —
 * Rust in the app, `node:http` in the tests — is a pipe with no opinions, and
 * the protocol has exactly one implementation.
 *
 * That split is what lets the whole of this be tested over real sockets without
 * building the app, and it is why there is no second copy of these rules written
 * in Rust to drift away from this one.
 */

export { LISTEN_PORT_HEADER, peerAddressFrom } from './syncServer/wire.js'
export type { SyncRequest, SyncResponse, SyncServerOptions } from './syncServer/wire.js'
export {
  PAIRING_WINDOW_MS, allowJoin, expectingAJoin, offerPairing, onJoinRequest, pairingOnOffer,
  pendingJoin, refuseJoin, withdrawPairing,
} from './syncServer/pairing.js'
export type { JoinRequest } from './syncServer/pairing.js'
export { serveAs, setServingRegisterSource } from './syncServer/serving.js'
export { handleOffer, handleSyncRequest } from './syncServer/handlers.js'
