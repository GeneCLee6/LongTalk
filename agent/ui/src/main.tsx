import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { AgentController } from './controller.ts'
import { locale } from './i18n.ts'
import { applyTheme } from './theme.ts'
import './agent.css'

applyTheme(locale)
const controller = new AgentController()
void controller.start()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
)
