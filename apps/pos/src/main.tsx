import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CoreProvider } from './core/CoreProvider'
import { startLogging } from './core/log'
import { holdTheKeys } from './core/holdTheKeys'
import App from './App'
import './ui/styles.css'

/* Before React, so that a throw while the first screen is being built is
   written down. That is the failure with no other witness: there is no screen
   yet to show it on. */
startLogging()

/* Also before React: the keys that reload the webview would otherwise sign the
   counter out mid-queue, and a listener added later is one a fast pair of hands
   can beat. */
holdTheKeys()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CoreProvider>
      <App />
    </CoreProvider>
  </StrictMode>,
)
