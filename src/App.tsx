import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { LoadFailedBoundary } from './components/LoadFailed.tsx'
import { UpdatePrompt } from './components/UpdatePrompt.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { useLocale } from './strings.ts'

// The room page is its own chunk: the home page must stay within its JS budget (CLAUDE.md rule 6)
const RoomPage = lazy(() => import('./pages/RoomPage.tsx'))
// The owner's dashboard (e11-t03): its own chunk, in neither the home nor the room page's JS
const AdminPage = lazy(() => import('./pages/AdminPage.tsx'))
// The account page (I2): its own chunk, with the WebAuthn code; accounts are optional
const MePage = lazy(() => import('./pages/MePage.tsx'))
// A scheduled meeting's public page (I3): its own chunk too, without the account API
const MeetingPage = lazy(() => import('./pages/MeetingPage.tsx'))
// The privacy policy (I6, e11-t07): its own chunk, its text loaded per language after that
const PrivacyPage = lazy(() => import('./pages/PrivacyPage.tsx'))

export function App() {
  // Switching language (G1, e4-t15) re-renders everything from here down with the other
  // dictionary; nothing remounts, so a call in progress carries on
  useLocale()
  return (
    <BrowserRouter>
      {/* A chunk that cannot be loaded shows 「載入失敗，請重新整理」, not a blank page (e4-t20) */}
      <LoadFailedBoundary>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/r/:roomId" element={<RoomPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/me" element={<MePage />} />
            <Route path="/m/:meetingId" element={<MeetingPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="*" element={<HomePage />} />
          </Routes>
        </Suspense>
      </LoadFailedBoundary>
      {/* 「有新版本，重新整理」 (e4-t12): never a reload by itself, a toast-like card in the room */}
      <UpdatePrompt />
    </BrowserRouter>
  )
}
