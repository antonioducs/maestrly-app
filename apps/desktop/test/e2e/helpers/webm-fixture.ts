import type { Page } from '@playwright/test'

/**
 * Records a short synthetic WebM (coloured frames with a counter) in the app's own renderer. No real media is used,
 * and nothing outside the test needs an encoder.
 */
export async function recordSyntheticWebm(page: Page, milliseconds = 2500): Promise<Buffer> {
  const { base64, duration } = await page.evaluate(async (length) => {
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 90
    const context = canvas.getContext('2d')!
    const stream = canvas.captureStream(25)
    const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type))
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 250_000 })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data)
    }
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve
    })
    let frame = 0
    const draw = () => {
      context.fillStyle = `hsl(${(frame * 15) % 360} 70% 45%)`
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#fff'
      context.font = '32px sans-serif'
      context.fillText(String(frame++), 12, 58)
    }
    draw()
    recorder.start()
    const started = performance.now()
    const timer = setInterval(draw, 40)
    await new Promise((resolve) => setTimeout(resolve, length))
    clearInterval(timer)
    recorder.stop()
    await stopped
    for (const track of stream.getTracks()) track.stop()
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { base64: btoa(binary), duration: performance.now() - started }
  }, milliseconds)
  return withWebmDuration(Buffer.from(base64, 'base64'), duration)
}

function vint(bytes: Buffer, at: number, keepMarker: boolean): { value: number; length: number } {
  const first = bytes[at]!
  let length = 1
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++
  if (length > 8) throw new Error('Invalid EBML variable-length integer')
  let value = keepMarker ? first : first & (0xff >> length)
  for (let index = 1; index < length; index++) value = value * 256 + bytes[at + index]!
  return { value, length }
}

function sizeBytes(value: number, length: number): Buffer {
  const out = Buffer.alloc(length)
  let rest = value
  for (let index = length - 1; index >= 0; index--) {
    out[index] = rest % 256
    rest = Math.floor(rest / 256)
  }
  if (rest !== 0 || value >= 2 ** (7 * length) - 1) throw new Error('EBML size does not fit')
  out[0]! |= 0x80 >> (length - 1)
  return out
}

const unknownSize = (length: number, value: number) => value === 2 ** (7 * length) - 1

/**
 * MediaRecorder writes live WebM without a duration, which players report as Infinity and cannot seek. Adds a
 * Duration element to the segment's Info, as an offline muxer would.
 */
export function withWebmDuration(input: Buffer, milliseconds: number): Buffer {
  let at = 0
  const header = vint(input, at, true)
  const headerSize = vint(input, at + header.length, false)
  at += header.length + headerSize.length + headerSize.value
  const segment = vint(input, at, true)
  if (segment.value !== 0x18538067) throw new Error('Missing WebM segment')
  const segmentSizeAt = at + segment.length
  const segmentSize = vint(input, segmentSizeAt, false)
  at = segmentSizeAt + segmentSize.length
  for (;;) {
    const id = vint(input, at, true)
    const sizeAt = at + id.length
    const size = vint(input, sizeAt, false)
    const dataAt = sizeAt + size.length
    if (id.value !== 0x1549a966) {
      if (unknownSize(size.length, size.value)) throw new Error('WebM Info not found')
      at = dataAt + size.value
      continue
    }
    let scale = 1_000_000
    for (let child = dataAt; child < dataAt + size.value; ) {
      const childId = vint(input, child, true)
      const childSize = vint(input, child + childId.length, false)
      const childData = child + childId.length + childSize.length
      if (childId.value === 0x4489) return input
      if (childId.value === 0x2ad7b1) scale = input.readUIntBE(childData, childSize.value)
      child = childData + childSize.value
    }
    const duration = Buffer.alloc(11)
    duration.set([0x44, 0x89, 0x88])
    duration.writeDoubleBE((milliseconds * 1_000_000) / scale, 3)
    const parts = [
      input.subarray(0, segmentSizeAt),
      unknownSize(segmentSize.length, segmentSize.value)
        ? input.subarray(segmentSizeAt, segmentSizeAt + segmentSize.length)
        : sizeBytes(segmentSize.value + duration.length, segmentSize.length),
      input.subarray(segmentSizeAt + segmentSize.length, sizeAt),
      sizeBytes(size.value + duration.length, size.length),
      input.subarray(dataAt, dataAt + size.value),
      duration,
      input.subarray(dataAt + size.value),
    ]
    return Buffer.concat(parts)
  }
}
