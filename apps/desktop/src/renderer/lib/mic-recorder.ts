/**
 * The microphone, as dictation and the assistant's voice use it: open a device (the chosen one, else the default),
 * record it, follow its level, and turn the recording into the 16 kHz mono samples transcription takes.
 */

const TARGET_RATE = 16000
const LEVEL_EVERY_MS = 50

export async function decodeTo16kMono(buf: ArrayBuffer): Promise<Float32Array> {
  const AC =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new AC()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(buf)
  } finally {
    void ctx.close()
  }
  const len = decoded.length
  const mono = new Float32Array(len)
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const data = decoded.getChannelData(ch)
    for (let i = 0; i < len; i++) mono[i] += data[i] / decoded.numberOfChannels
  }
  if (decoded.sampleRate === TARGET_RATE) return mono
  const outLen = Math.max(1, Math.ceil((len * TARGET_RATE) / decoded.sampleRate))
  const offline = new OfflineAudioContext(1, outLen, TARGET_RATE)
  const srcBuf = offline.createBuffer(1, len, decoded.sampleRate)
  srcBuf.getChannelData(0).set(mono)
  const src = offline.createBufferSource()
  src.buffer = srcBuf
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

/**
 * Asks the system for the microphone, then opens the chosen device, or the default one when it is gone. `processing`
 * asks for the browser's audio processing (echo cancellation and the like) on either.
 */
export async function openMicStream(
  deviceId?: string | null,
  processing?: MediaTrackConstraints
): Promise<MediaStream> {
  await window.api.chatEnsureMicAccess().catch(() => {})
  const fallback: MediaTrackConstraints | true = processing ?? true
  const wanted = deviceId ? { ...processing, deviceId: { exact: deviceId } } : fallback
  return navigator.mediaDevices
    .getUserMedia({ audio: wanted })
    .catch(() => navigator.mediaDevices.getUserMedia({ audio: fallback }))
}

export interface MicRecording {
  /** Ends the recording and returns what it heard, as 16 kHz mono samples (empty when it heard nothing). */
  stop(): Promise<Float32Array>
  /** Ends it and drops what it heard. */
  cancel(): void
}

/** Records the microphone; `onLevel` hears its loudness (RMS, 0–1) every 50 ms, timed from the start. */
export async function startMicRecording(
  opts: { deviceId?: string | null; onLevel?: (rms: number, atMs: number) => void } = {}
): Promise<MicRecording> {
  const stream = await openMicStream(opts.deviceId)
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })
  let levels: AudioContext | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  if (opts.onLevel) {
    const onLevel = opts.onLevel
    levels = new AudioContext()
    const analyser = levels.createAnalyser()
    analyser.fftSize = 1024
    levels.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    const startedAt = performance.now()
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += sample * sample
      onLevel(Math.sqrt(sum / samples.length), performance.now() - startedAt)
    }, LEVEL_EVERY_MS)
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (timer) clearInterval(timer)
    void levels?.close().catch(() => {})
    for (const track of stream.getTracks()) track.stop()
  }
  recorder.start()
  return {
    async stop() {
      if (recorder.state !== 'inactive') recorder.stop()
      await stopped
      release()
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      if (!blob.size) return new Float32Array(0)
      return decodeTo16kMono(await blob.arrayBuffer())
    },
    cancel() {
      chunks.length = 0
      if (recorder.state !== 'inactive') recorder.stop()
      release()
    },
  }
}
