import { openMicStream } from '@/lib/mic-recorder'
import type { VoiceSessionState } from './use-voice-session'
import captureUrl from './wake-capture.worklet.ts?worker&url'
import { createBurstGate } from './wake-gate'

export function shouldListen(wake: { listening: boolean }, voice: VoiceSessionState): boolean {
  return wake.listening && (voice === 'idle' || voice === 'error')
}

export async function startWakeListener(opts: {
  deviceId: string | null
  onBurst(pcm: Float32Array): void
}): Promise<{ stop(): void }> {
  const stream = await openMicStream(opts.deviceId, {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  })
  const context = new AudioContext({ sampleRate: 16000 })
  const stop = () => {
    for (const t of stream.getTracks()) t.stop()
    void context.close().catch(() => {})
  }
  try {
    await context.audioWorklet.addModule(captureUrl)
    // No outputs: Chromium still runs a sink node, and nothing plays.
    const node = new AudioWorkletNode(context, 'wake-capture', { numberOfOutputs: 0 })
    const gate = createBurstGate()
    node.port.onmessage = ({ data }) => {
      const burst = gate.push(data as Float32Array)
      if (burst) opts.onBurst(burst)
    }
    context.createMediaStreamSource(stream).connect(node)
    if (context.state === 'suspended') await context.resume()
  } catch (error) {
    stop()
    throw error
  }
  return { stop }
}
