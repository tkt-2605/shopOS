/*
 * Inside the Android app (mobile/storefront, a Capacitor shell) the page is
 * the same storefront. Two things differ:
 *
 *   - Google refuses its web button inside an app's webview, so sign-in goes
 *     through the phone's own Google account picker. The token it gives is
 *     issued to the same web client id, so the till checks it as it does now.
 *   - The app carries its own files, so no service worker is registered.
 *
 * Capacitor's bridge is reached through `window.Capacitor`, which the app
 * injects; nothing from Capacitor is bundled, so the website is unchanged.
 */

interface Bridge {
  isNativePlatform(): boolean
  nativePromise<T>(plugin: string, method: string, options?: unknown): Promise<T>
}

function bridge(): Bridge | null {
  const cap = (window as { Capacitor?: Bridge }).Capacitor
  return cap?.isNativePlatform?.() ? cap : null
}

export const inApp = (): boolean => bridge() !== null

let ready: string | null = null

/** Asks the phone's Google account picker for an ID token issued to `webClientId`. */
export async function nativeGoogleToken(webClientId: string): Promise<string> {
  const cap = bridge()
  if (!cap) throw new Error('Not in the app')
  if (ready !== webClientId) {
    await cap.nativePromise('SocialLogin', 'initialize', { google: { webClientId, mode: 'online' } })
    ready = webClientId
  }
  /* No `scopes`: the plugin refuses them unless MainActivity is changed, and
     the ID token already carries the name and email the shop needs. */
  const r = await cap.nativePromise<{ result?: { idToken?: string | null } }>('SocialLogin', 'login', {
    provider: 'google', options: {},
  })
  const token = r.result?.idToken
  if (!token) throw new Error('Google gave no token')
  return token
}
