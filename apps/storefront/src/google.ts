/*
 * "Sign in with Google", with Google's own button.
 *
 * The button gives the page an ID token signed by Google; the page hands it to
 * the shop's till, which checks the signature itself and answers with a
 * session of its own. Nothing about the customer passes through anybody else.
 */

interface GoogleId {
  initialize(options: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean }): void
  renderButton(el: HTMLElement, options: Record<string, unknown>): void
}

declare global {
  interface Window { google?: { accounts: { id: GoogleId } } }
}

let loading: Promise<GoogleId> | null = null

function load(): Promise<GoogleId> {
  if (window.google) return Promise.resolve(window.google.accounts.id)
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => (window.google ? resolve(window.google.accounts.id) : reject(new Error('Google sign-in did not load')))
    script.onerror = () => { loading = null; reject(new Error('Google sign-in did not load')) }
    document.head.appendChild(script)
  })
  return loading
}

export async function showGoogleButton(el: HTMLElement, clientId: string, onToken: (token: string) => void): Promise<void> {
  const id = await load()
  id.initialize({ client_id: clientId, callback: (r) => onToken(r.credential) })
  id.renderButton(el, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 280 })
}
