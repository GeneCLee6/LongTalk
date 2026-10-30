import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { HomePage } from './pages/HomePage.tsx'

// The room page is its own chunk: the home page must stay within its JS budget (CLAUDE.md rule 6)
const RoomPage = lazy(() => import('./pages/RoomPage.tsx'))
// A2 spike: two-browser Cloudflare Realtime check (DEPLOY.md §5). Its own chunk, never loaded by
// the home or room page
const RealtimeSpikePage = lazy(() => import('./pages/RealtimeSpikePage.tsx'))

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/r/:roomId" element={<RoomPage />} />
          <Route path="/dev/realtime" element={<RealtimeSpikePage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
