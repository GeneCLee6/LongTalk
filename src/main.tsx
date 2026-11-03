import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { takePasswordFromUrl } from './room/roomPassword.ts'
import { GlobalStyle } from './styles/GlobalStyle.ts'
import { installTelemetry } from './telemetry.ts'

// A link's ?pwd= (F3, e1-t15) leaves the address bar before telemetry or the app can see it
takePasswordFromUrl()

// Uncaught errors and unhandled rejections go to /api/events, scrubbed and capped (e11-t03)
installTelemetry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlobalStyle />
    <App />
  </StrictMode>,
)
