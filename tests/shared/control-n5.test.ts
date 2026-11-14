// N5 (e9-t08, e9-t09; docs/PRD/f-remote-control-security.md §5.11, §5.12, T-22): the shapes the
// controller, the room and the agent share for pasting text and for what the agent says about the
// live grant. The Rust agent mirrors parseControlPaste (agent/src-tauri/src/control.rs tests).
import { describe, expect, it } from 'vitest'
import {
  CONTROL_CLIPBOARD_RATE,
  MAX_CLIPBOARD_CHARS,
  MAX_PASTE_FRAME_CHARS,
  normalizeClipboardText,
  parseAgentMessage,
  parseControlAnswer,
  parseControlClientMessage,
  parseControlPaste,
  parseControlStatus,
} from '../../shared/control.ts'
import { MAX_CLIENT_MESSAGE_CHARS, parseClientMessage } from '../../shared/protocol.ts'

const GRANT = 'A'.repeat(22)
const REQUEST = 'B'.repeat(22)

describe('normalizeClipboardText', () => {
  it('takes text with tabs and line breaks, as it is', () => {
    expect(normalizeClipboardText('git push\n\tdone\r\n')).toBe('git push\n\tdone\r\n')
    expect(normalizeClipboardText('台北市信義區 👍')).toBe('台北市信義區 👍')
    expect(normalizeClipboardText('x'.repeat(MAX_CLIPBOARD_CHARS))).toHaveLength(
      MAX_CLIPBOARD_CHARS,
    )
  })

  it('refuses what is not text, empty, too long, or hides what it is', () => {
    for (const raw of [
      null,
      42,
      '',
      'x'.repeat(MAX_CLIPBOARD_CHARS + 1),
      'a\u0000b',
      'a\u001bb',
      'a\u007fb',
      'a\u0085b',
      'invoice\u202Efdp.exe',
      'a\u2066b',
      '\uD800',
      'x\uDC00',
    ]) {
      expect(normalizeClipboardText(raw)).toBeNull()
    }
  })
})

describe('the paste on the wire', () => {
  it('a controller’s controlClipboard, through the browser parser', () => {
    const message = { t: 'controlClipboard', grant: GRANT, text: 'hello' }
    expect(parseControlClientMessage(message)).toEqual(message)
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message)
    expect(parseClientMessage(JSON.stringify({ ...message, grant: 'short' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ ...message, text: '' }))).toBeNull()
  })

  it('the longest paste fits a browser frame and the agent’s frame, in UTF-16 and in UTF-8', () => {
    const bytes = (value: string) => new TextEncoder().encode(value).length
    for (const unit of ['\n', '中', '\t', '"']) {
      const text = unit.repeat(MAX_CLIPBOARD_CHARS)
      const client = JSON.stringify({ t: 'controlClipboard', grant: GRANT, text })
      expect(client.length).toBeLessThanOrEqual(MAX_CLIENT_MESSAGE_CHARS)
      const frame = JSON.stringify({ t: 'controlPaste', grant: GRANT, text })
      expect(frame.length).toBeLessThanOrEqual(MAX_PASTE_FRAME_CHARS)
      expect(bytes(frame)).toBeLessThanOrEqual(MAX_PASTE_FRAME_CHARS)
      expect(parseControlPaste(frame)?.text).toBe(text)
    }
  })

  it('parseControlPaste: the kind, the id and the text’s rules', () => {
    const ok = { t: 'controlPaste', grant: GRANT, text: 'hi' }
    expect(parseControlPaste(JSON.stringify(ok))).toEqual(ok)
    expect(parseControlPaste(JSON.stringify({ ...ok, t: 'controlForward' }))).toBeNull()
    expect(parseControlPaste(JSON.stringify({ ...ok, grant: 1 }))).toBeNull()
    expect(parseControlPaste(JSON.stringify({ ...ok, text: 'a\u0007' }))).toBeNull()
    expect(
      parseControlPaste(JSON.stringify({ ...ok, pad: 'x'.repeat(MAX_PASTE_FRAME_CHARS) })),
    ).toBeNull()
    expect(parseControlPaste('not json')).toBeNull()
  })

  it('a person pastes by hand: a few per CONTROL_CLIPBOARD_RATE window', () => {
    expect(CONTROL_CLIPBOARD_RATE.count).toBeLessThanOrEqual(5)
    expect(CONTROL_CLIPBOARD_RATE.windowMs).toBeGreaterThanOrEqual(5_000)
  })
})

describe('the consent dialog’s clipboard tick (controlAnswer.clipboard)', () => {
  it('kept with an allow, dropped with a deny, absent when not ticked', () => {
    expect(
      parseControlAnswer({
        t: 'controlAnswer',
        request: REQUEST,
        decision: 'allow10',
        clipboard: true,
      }),
    ).toEqual({ t: 'controlAnswer', request: REQUEST, decision: 'allow10', clipboard: true })
    expect(
      parseControlAnswer({
        t: 'controlAnswer',
        request: REQUEST,
        decision: 'deny',
        clipboard: true,
      }),
    ).toEqual({ t: 'controlAnswer', request: REQUEST, decision: 'deny' })
    expect(
      parseControlAnswer({
        t: 'controlAnswer',
        request: REQUEST,
        decision: 'allow10',
        clipboard: false,
      }),
    ).toEqual({ t: 'controlAnswer', request: REQUEST, decision: 'allow10' })
    expect(
      parseControlAnswer({ t: 'controlAnswer', request: REQUEST, decision: 'allow10' }),
    ).toEqual({ t: 'controlAnswer', request: REQUEST, decision: 'allow10' })
  })

  it('refuses a clipboard that is not a boolean', () => {
    expect(
      parseControlAnswer({
        t: 'controlAnswer',
        request: REQUEST,
        decision: 'allow10',
        clipboard: 1,
      }),
    ).toBeNull()
  })
})

describe('controlStatus (the agent about its grant)', () => {
  it('blocked by the secure desktop or nothing, and whether pasting is still on', () => {
    const ok = { t: 'controlStatus', grant: GRANT, blocked: 'secureDesktop', clipboard: false }
    expect(parseControlStatus(ok)).toEqual(ok)
    expect(parseControlStatus({ ...ok, blocked: null })).toEqual({ ...ok, blocked: null })
    expect(parseAgentMessage(JSON.stringify(ok))).toEqual(ok)
  })

  it('refuses anything else', () => {
    const ok = { t: 'controlStatus', grant: GRANT, blocked: null, clipboard: true }
    expect(parseControlStatus({ ...ok, blocked: 'uac' })).toBeNull()
    expect(parseControlStatus({ ...ok, blocked: undefined })).toBeNull()
    expect(parseControlStatus({ ...ok, clipboard: 'yes' })).toBeNull()
    expect(parseControlStatus({ ...ok, grant: 'x' })).toBeNull()
    // A browser cannot send it (T-02)
    expect(parseClientMessage(JSON.stringify(ok))).toBeNull()
  })
})
