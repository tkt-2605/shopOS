import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CoreProvider } from './core/CoreProvider'
import { startLogging } from './core/log'
import App from './App'
import './ui/styles.css'

/* Before React, so that a throw while the first screen is being built is
   written down. That is the failure with no other witness: there is no screen
   yet to show it on. */
startLogging()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CoreProvider>
      <App />
    </CoreProvider>
  </StrictMode>,
)
