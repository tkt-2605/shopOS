/*
 * In pieces: `registers/counters.ts` is the counters themselves,
 * `registers/claims.ts` which till is billing on which, and `registers/device.ts`
 * which counter this machine is. Re-exported here, where callers find them.
 */

/**
 * A shop can run several counters. Each gets its own prefix, because that prefix
 * is what keeps two tills billing at the same moment from minting the same
 * invoice number — a globally sequential counter cannot survive a second till.
 */

export { createRegister, listRegisters, renameRegister, setRegisterActive } from './registers/counters.js'
export type { Register, RegisterResult } from './registers/counters.js'
export { ensureOwnRegister, prefixFor } from './registers/own.js'
export {
  countersOtherTillsUse, forgetLegacyDeviceRegister, legacyDeviceRegister, myRegisterPrefix,
  resolveDeviceRegister,
} from './registers/device.js'
export {
  CLAIM_GOES_STALE_MS, claimIfUnclaimed, claimRegister, claims, clearGhostClaims, forgetPeer,
  ghostClaims, renewClaim, takeRegister, assertCounterIsMine, CounterTakenError, grantClaim, changeCounter,
} from './registers/claims.js'
export type { Claim, CounterTaken, TakeRegisterResult, ClaimAsk, ClaimAnswer, CounterChange } from './registers/claims.js'
