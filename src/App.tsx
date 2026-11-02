import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { LoadFailedBoundary } from './components/LoadFailed.tsx'
import { HomePage } from './pages/HomePage.tsx'

// The room page is its own chunk: the home page must stay within its JS budget (CLAUDE.md rule 6)
const RoomPage = lazy(() => import('./pages/RoomPage.tsx'))

export function App() {
  return (
    <BrowserRouter>
      {/* A chunk that cannot be loaded shows 「載入失敗，請重新整理」, not a blank page (e4-t20) */}
      <LoadFailedBoundary>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/r/:roomId" element={<RoomPage />} />
            <Route path="*" element={<HomePage />} />
          </Routes>
        </Suspense>
      </LoadFailedBoundary>
    </BrowserRouter>
  )
}
