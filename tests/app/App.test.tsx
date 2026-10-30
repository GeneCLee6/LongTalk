import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '../../src/App.tsx'

describe('App', () => {
  it('shows the home page at /', () => {
    window.history.pushState({}, '', '/')
    render(<App />)
    expect(screen.getByRole('heading', { name: 'LongTalk' })).toBeInTheDocument()
  })

  it('shows the room page at /r/:roomId', async () => {
    window.history.pushState({}, '', '/r/abc123')
    render(<App />)
    expect(await screen.findByRole('heading', { name: '會議室 abc123' })).toBeInTheDocument()
  })
})
