import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { BorderWindow, ConsentWindow, StopWindow } from './control.tsx'
import { AgentController } from './controller.ts'
import { locale } from './i18n.ts'
import { applyTheme } from './theme.ts'
import './agent.css'

applyTheme(locale)

// One bundle, several windows (N3): Rust opens the remote-control ones on index.html with a hash
// (src-tauri/src/control_windows.rs); only the main window runs the session
function root() {
  switch (location.hash) {
    case '#consent':
      return <ConsentWindow />
    case '#stop':
      return <StopWindow />
    case '#border':
      document.documentElement.dataset.window = 'border'
      return <BorderWindow />
    default: {
      const controller = new AgentController()
      void controller.start()
      return <App controller={controller} />
    }
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode>{root()}</StrictMode>)
