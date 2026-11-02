import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { GlobalStyle } from './styles/GlobalStyle.ts'
import { installTelemetry } from './telemetry.ts'

// Uncaught errors and unhandled rejections go to /api/events, scrubbed and capped (e11-t03)
installTelemetry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlobalStyle />
    <App />
  </StrictMode>,
)
