import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CoreProvider } from './core/CoreProvider'
import App from './App'
import './ui/styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CoreProvider>
      <App />
    </CoreProvider>
  </StrictMode>,
)
