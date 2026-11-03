import { describe, expect, it, vi } from 'vitest'
import {
  START_BITRATE_KBPS,
  VIDEO_SEND,
  applyDegradation,
  sendEncoding,
  videoSendParameters,
  withStartBitrate,
} from '../../../src/media/encoding.ts'

const join = (...lines: string[]) => lines.join('\r\n')

describe('video send parameters (field test 2026-11-03)', () => {
  it('gives the screen the uplink and 30 fps with balanced degradation; caps the camera', () => {
    expect(videoSendParameters('screen')).toEqual({
      maxBitrate: 2_500_000,
      maxFramerate: 30,
      priority: 'high',
      degradationPreference: 'balanced',
    })
    expect(videoSendParameters('cam')?.maxBitrate).toBeLessThan(VIDEO_SEND.screen.maxBitrate)
    expect(videoSendParameters('mic')).toBeNull()
    expect(videoSendParameters('screenAudio')).toBeNull()
    expect(sendEncoding(VIDEO_SEND.screen)).toEqual({
      maxBitrate: 2_500_000,
      maxFramerate: 30,
      priority: 'high',
      networkPriority: 'high',
    })
  })

  it('sets the degradation preference, and keeps going where the browser refuses it', async () => {
    const setParameters = vi.fn(async (_params: unknown) => {})
    const sender = {
      getParameters: () => ({ transactionId: 'a', encodings: [{ maxBitrate: 1 }] }),
      setParameters,
    } as unknown as RTCRtpSender
    await applyDegradation(sender, VIDEO_SEND.screen)
    expect(setParameters).toHaveBeenCalledWith({
      transactionId: 'a',
      encodings: [{ maxBitrate: 1 }],
      degradationPreference: 'balanced',
    })
    setParameters.mockRejectedValueOnce(new Error('InvalidModificationError'))
    await expect(applyDegradation(sender, VIDEO_SEND.screen)).resolves.toBeUndefined()
    await expect(applyDegradation({} as RTCRtpSender, VIDEO_SEND.screen)).resolves.toBeUndefined()
    setParameters.mockClear()
    await applyDegradation(sender, VIDEO_SEND.cam)
    expect(setParameters).not.toHaveBeenCalled()
  })
})

describe('withStartBitrate', () => {
  const param = `x-google-start-bitrate=${START_BITRATE_KBPS}`

  it('adds an fmtp line to VP8 where the answer has none, appends where it has one', () => {
    const sdp = join(
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
      'a=rtpmap:96 VP8/90000',
      'a=rtpmap:97 rtx/90000',
      'a=fmtp:97 apt=96',
      'm=video 9 UDP/TLS/RTP/SAVPF 100',
      'a=rtpmap:100 VP8/90000',
      'a=fmtp:100 max-fr=30',
      '',
    )
    expect(withStartBitrate(sdp)).toBe(
      join(
        'v=0',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=rtpmap:111 opus/48000/2',
        'a=fmtp:111 minptime=10;useinbandfec=1',
        'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
        'a=rtpmap:96 VP8/90000',
        `a=fmtp:96 ${param}`,
        'a=rtpmap:97 rtx/90000',
        'a=fmtp:97 apt=96',
        'm=video 9 UDP/TLS/RTP/SAVPF 100',
        'a=rtpmap:100 VP8/90000',
        `a=fmtp:100 max-fr=30;${param}`,
        '',
      ),
    )
  })

  it('looks at each media section on its own (payload numbers repeat)', () => {
    const sdp = join(
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 VP8/90000',
      'a=fmtp:96 max-fr=30',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 VP8/90000',
    )
    const out = withStartBitrate(sdp).split('\r\n')
    expect(out.filter((line) => line.includes(param))).toHaveLength(2)
  })

  it('leaves audio-only answers and an existing start bitrate alone', () => {
    const audio = join('m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2')
    expect(withStartBitrate(audio)).toBe(audio)
    const set = join(
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 VP8/90000',
      'a=fmtp:96 x-google-start-bitrate=500',
    )
    expect(withStartBitrate(set)).toBe(set)
  })
})
