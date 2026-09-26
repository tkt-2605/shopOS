
/*
 * Which counter this till answers as, for the hello a peer is sent.
 */

/**
 * Which counter this till sits at, told to us by the app at startup.
 *
 * The answering side has no way to ask `device.json` — that is the webview's —
 * so it is handed in. Null means never chosen, and `resolveDeviceRegister` then
 * falls back to the first active counter, which is exactly the case the asking
 * side refuses.
 */
let servingRegister: string | null = null
let servingRegisterSource: (() => string | null) | null = null

export function serveAs(registerId: string | null): void {
  servingRegister = registerId
}

/**
 * For a host serving more than one till from one process — `tools/virtual-till`.
 *
 * Same reasoning as `setDeviceIdSource`, and the same failure if it is missing:
 * two tills sharing this global answer `/hello` with one another's counter, so
 * the `SAME_REGISTER` refusal that `same-register.test.ts` exists to prove
 * either never fires or fires against the wrong till. The app never calls this.
 */
export function setServingRegisterSource(fn: (() => string | null) | null): void {
  servingRegisterSource = fn
}

export function currentServingRegister(): string | null {
  return servingRegisterSource ? servingRegisterSource() : servingRegister
}
