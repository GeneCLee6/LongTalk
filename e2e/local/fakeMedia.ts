import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Chrome's fake camera and microphone, made still (G5, e4-t17): its own fake camera draws a
 * moving pie and its fake microphone beeps, so screenshots would differ every time and the
 * speaking outline would come and go. A one-frame Y4M (Chrome repeats it) and a second of silence
 * make every frame the same. Written once per run, outside the repository.
 */
export function fakeMediaFiles(): { video: string; audio: string } {
  const dir = join(tmpdir(), 'longtalk-e2e-media')
  mkdirSync(dir, { recursive: true })
  const video = join(dir, 'still.y4m')
  const audio = join(dir, 'silence.wav')
  writeFileSync(video, stillFrame(640, 360))
  writeFileSync(audio, silence(48_000))
  return { video, audio }
}

/** A 4:2:0 Y4M of one frame: soft horizontal bands of grey-blue, so mirroring and scaling show */
function stillFrame(width: number, height: number): Buffer {
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\nFRAME\n`)
  const luma = Buffer.alloc(width * height)
  for (let y = 0; y < height; y++) {
    const band = Math.floor((y / height) * 6)
    luma.fill(60 + band * 16, y * width, (y + 1) * width)
  }
  // A lighter block left of centre: a mirrored picture puts it on the right
  for (let y = Math.round(height / 3); y < Math.round((height * 2) / 3); y++) {
    luma.fill(200, y * width + Math.round(width / 6), y * width + Math.round(width / 3))
  }
  const chroma = (width / 2) * (height / 2)
  const u = Buffer.alloc(chroma, 140)
  const v = Buffer.alloc(chroma, 118)
  return Buffer.concat([header, luma, u, v])
}

/** A mono 16-bit PCM WAV of silence */
function silence(samples: number): Buffer {
  const rate = 48_000
  const data = samples * 2
  const wav = Buffer.alloc(44 + data)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + data, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(data, 40)
  return wav
}
