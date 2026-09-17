import { useCallback, useEffect, useRef, useState } from 'react'
import type { TargetRef, VoiceClip, VoiceJob } from '@maestrly/host-protocol'
import { MAX_DURATION_MS, base64, browserDecoder, toCanonicalWav } from './pcm'

export type VoiceStage = 'idle' | 'permission' | 'recording' | 'converting' | 'uploading' | 'transcribing' | 'ready' | 'failed'
export interface VoiceDraft {
  stage: VoiceStage
  /** Where this recording is going, fixed when it started. */
  target: TargetRef
  hostId: string
  clientClipId: string
  elapsedMs: number
  clip?: VoiceClip
  job?: VoiceJob
  text: string
  error?: string
}

const stageOrder: VoiceStage[] = ['idle', 'permission', 'recording', 'converting', 'uploading', 'transcribing', 'ready', 'failed']

/**
 * The lifecycle of one voice note, from the button to a text the person can edit.
 *
 * Two rules shape this hook. Recording only ever happens between an explicit press and an
 * explicit stop: the track is released on cancel, on error, on a target change, on navigation
 * and on unmount — including the awkward case where the permission prompt resolves after the
 * component is already gone.
 *
 * And the destination is fixed when the recording starts. A transcription that arrives late
 * never writes into another bot's composer, never overwrites text the person typed meanwhile
 * and never sends by itself: using the text is always a second, deliberate act.
 */
/** Exactly one input when the person chose one; otherwise whatever the system considers default. */
export function microphoneConstraints(deviceId: string | undefined): MediaStreamConstraints {
  return { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false }
}
/** The browser's ways of saying "that device is not here any more". */
export function isDeviceLost(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'OverconstrainedError' || name === 'NotFoundError'
}
export function useVoiceDraft(input: {
  target: TargetRef
  hostId: string
  api: {
    voice: {
      call: (call: { method: string; params: Record<string, unknown> }) => Promise<unknown>
      upload: (value: { target: TargetRef; clientClipId: string; dataBase64: string; durationMs: number }) => Promise<VoiceClip>
      requestMicrophone: () => Promise<{ access: string }>
      arm: (armed: boolean) => Promise<{ armed: boolean }>
    }
  }
  newId: () => string
  /** The input the person chose; undefined leaves the choice to the system. */
  deviceId?: string
  /** Called when the chosen input no longer exists; the recording continues on the default one. */
  onDeviceLost?: () => void
  /** Injection seam for tests; production uses the browser's own capture. */
  capture?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  decode?: (data: ArrayBuffer) => Promise<AudioBuffer>
}) {
  const [draft, setDraft] = useState<VoiceDraft | undefined>()
  const stream = useRef<MediaStream | undefined>(undefined)
  const recorder = useRef<MediaRecorder | undefined>(undefined)
  const chunks = useRef<Blob[]>([])
  const mounted = useRef(true)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const started = useRef(0)

  /** The one place that lets go of the microphone; every exit path goes through it. */
  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current)
    timer.current = undefined
    try {
      recorder.current?.state !== 'inactive' && recorder.current?.stop()
    } catch {
      /* a recorder that already stopped is not an error */
    }
    recorder.current = undefined
    for (const track of stream.current?.getTracks() ?? []) track.stop()
    stream.current = undefined
    void input.api.voice.arm(false).catch(() => {})
  }, [input.api])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      release()
    }
  }, [release])

  // Changing bot or Host abandons the recording instead of pointing it somewhere else.
  useEffect(() => {
    setDraft((current) => {
      if (!current) return current
      if (current.target.id === input.target.id && current.hostId === input.hostId) return current
      release()
      return undefined
    })
  }, [input.target.id, input.target.kind, input.hostId, release])

  const fail = useCallback(
    (message: string) => {
      release()
      if (mounted.current) setDraft((current) => (current ? { ...current, stage: 'failed', error: message } : current))
    },
    [release]
  )

  const start = useCallback(async () => {
    if (draft && draft.stage !== 'idle' && draft.stage !== 'failed') return
    const clientClipId = input.newId()
    const base: VoiceDraft = { stage: 'permission', target: input.target, hostId: input.hostId, clientClipId, elapsedMs: 0, text: '' }
    setDraft(base)
    try {
      const { access } = await input.api.voice.requestMicrophone()
      if (access !== 'granted') {
        fail(
          access === 'restricted'
            ? 'O microfone está bloqueado por uma política deste Mac.'
            : 'Permita o acesso ao microfone em Ajustes do Sistema › Privacidade e Segurança › Microfone.'
        )
        return
      }
      // Armed only now, and only for as long as this recording lasts.
      await input.api.voice.arm(true)
      const capture = input.capture ?? ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints))
      let media: MediaStream
      try {
        media = await capture(microphoneConstraints(input.deviceId))
      } catch (failure) {
        // A microphone that was unplugged must not block the note: fall back to the default one.
        if (!input.deviceId || !isDeviceLost(failure)) throw failure
        input.onDeviceLost?.()
        media = await capture(microphoneConstraints(undefined))
      }
      // The person may have cancelled or navigated while the prompt was open.
      if (!mounted.current) {
        for (const track of media.getTracks()) track.stop()
        void input.api.voice.arm(false).catch(() => {})
        return
      }
      stream.current = media
      chunks.current = []
      const recording = new MediaRecorder(media)
      recorder.current = recording
      recording.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data)
      }
      recording.onerror = () => fail('A gravação foi interrompida.')
      recording.start(250)
      started.current = Date.now()
      timer.current = setInterval(() => {
        const elapsedMs = Date.now() - started.current
        setDraft((current) => (current && current.stage === 'recording' ? { ...current, elapsedMs } : current))
        if (elapsedMs >= MAX_DURATION_MS) void stop()
      }, 200)
      setDraft((current) => (current ? { ...current, stage: 'recording' } : current))
    } catch {
      fail('Não foi possível acessar o microfone.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, fail, input])

  const stop = useCallback(async () => {
    const recording = recorder.current
    const media = stream.current
    if (!recording || !media) return
    const finished = new Promise<Blob>((resolve) => {
      recording.onstop = () => resolve(new Blob(chunks.current, { type: chunks.current[0]?.type || 'audio/webm' }))
    })
    try {
      recording.stop()
    } catch {
      /* already stopped */
    }
    const blob = await finished
    release()
    if (!mounted.current) return
    setDraft((current) => (current ? { ...current, stage: 'converting' } : current))
    try {
      const { wav, durationMs } = await toCanonicalWav(blob, input.decode ?? browserDecoder)
      if (!mounted.current) return
      setDraft((current) => (current ? { ...current, stage: 'uploading', elapsedMs: durationMs } : current))
      const pending = draft
      const clip = await input.api.voice.upload({
        target: pending?.target ?? input.target,
        clientClipId: pending?.clientClipId ?? input.newId(),
        dataBase64: base64(wav),
        durationMs,
      })
      if (!mounted.current) return
      setDraft((current) => (current ? { ...current, stage: 'transcribing', clip } : current))
      const job = (await input.api.voice.call({ method: 'voice.transcribe', params: { clipId: clip.id, idempotencyKey: input.newId() } })) as VoiceJob
      await poll(job)
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Não foi possível preparar esta gravação.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, fail, input, release])

  const poll = useCallback(
    async (job: VoiceJob) => {
      for (let attempt = 0; attempt < 600 && mounted.current; attempt++) {
        const current = (await input.api.voice.call({ method: 'voice.job.inspect', params: { jobId: job.id } })) as VoiceJob
        if (current.state === 'succeeded') {
          if (!mounted.current) return
          // The text lands in the draft, never in the composer and never in a send.
          setDraft((existing) => (existing ? { ...existing, stage: 'ready', job: current, text: current.transcript ?? '' } : existing))
          return
        }
        if (current.state === 'failed' || current.state === 'cancelled') {
          fail(
            current.failureCode === 'ASR_NO_SPEECH'
              ? 'Não identificamos fala nesta gravação.'
              : current.failureCode === 'ASR_MODEL_MISSING'
                ? 'Este computador ainda não tem a transcrição instalada.'
                : 'Não foi possível transcrever esta gravação.'
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    },
    [fail, input.api]
  )

  const cancel = useCallback(async () => {
    const current = draft
    release()
    setDraft(undefined)
    if (current?.job && (current.job.state === 'queued' || current.job.state === 'running'))
      await input.api.voice.call({ method: 'voice.job.cancel', params: { jobId: current.job.id } }).catch(() => {})
    if (current?.clip) await input.api.voice.call({ method: 'voice.clip.remove', params: { clipId: current.clip.id, idempotencyKey: input.newId() } }).catch(() => {})
  }, [draft, input, release])

  const edit = useCallback((text: string) => setDraft((current) => (current ? { ...current, text } : current)), [])
  const discard = useCallback(() => {
    release()
    setDraft(undefined)
  }, [release])

  return { draft, start, stop, cancel, edit, discard, stageOrder }
}
