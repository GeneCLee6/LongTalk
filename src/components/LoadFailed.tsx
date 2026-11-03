import { Component, type ErrorInfo, type ReactNode } from 'react'
import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, font, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'

/**
 * 「載入失敗，請重新整理」 (e4-t20): what shows instead of a blank page when a part of the app
 * cannot be loaded: a lazy chunk (the room page; later the whiteboard, blur, recording) whose
 * download failed on a network blip, or that a newer deployment replaced while this page was
 * open. Reloading fetches the current files.
 */
export function LoadFailedScreen({
  onReload = () => location.reload(),
}: {
  onReload?: () => void
}) {
  return (
    <Page>
      <Panel role="alert">
        <h1>{strings.loadFailed.title}</h1>
        <p>{strings.loadFailed.body}</p>
        <Button onClick={onReload}>{strings.loadFailed.reload}</Button>
      </Panel>
    </Page>
  )
}

interface BoundaryState {
  failed: boolean
}

/**
 * Catches what its children throw while rendering, a lazy import that failed included, and shows
 * LoadFailedScreen. Anything else that breaks rendering lands here too: a reload is the way out
 * of that as well, and better than a blank page.
 */
export class LoadFailedBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('LongTalk could not render', error, info.componentStack)
  }

  render(): ReactNode {
    return this.state.failed ? <LoadFailedScreen /> : this.props.children
  }
}

const Page = styled.main`
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: ${space(6)};
  font-family: ${font.current};
  background: ${color.bg};
  color: ${color.fg};
`

const Panel = styled.section`
  display: grid;
  justify-items: center;
  gap: ${space(3)};
  max-width: 420px;
  text-align: center;

  h1 {
    margin: 0;
    font-size: 22px;
  }
  p {
    margin: 0;
    color: ${color.muted};
    line-height: 1.6;
  }
`
