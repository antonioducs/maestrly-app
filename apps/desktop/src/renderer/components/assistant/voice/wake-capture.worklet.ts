declare const AudioWorkletProcessor: { new (): { readonly port: MessagePort } }
declare function registerProcessor(name: string, ctor: unknown): void

const FRAME_SAMPLES = 320

class WakeCaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(FRAME_SAMPLES)
  private offset = 0

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    let i = 0
    while (i < channel.length) {
      const take = Math.min(FRAME_SAMPLES - this.offset, channel.length - i)
      this.buffer.set(channel.subarray(i, i + take), this.offset)
      this.offset += take
      i += take
      if (this.offset === FRAME_SAMPLES) {
        const frame = this.buffer.slice()
        this.port.postMessage(frame, [frame.buffer])
        this.offset = 0
      }
    }
    return true
  }
}

registerProcessor('wake-capture', WakeCaptureProcessor)
