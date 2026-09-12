import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mic, MicOff, Square, Loader2, ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'recording' | 'transcribing' | 'silent'

const DEVICE_KEY = 'chat.mic.deviceId'
const HOLD_KEY = 'chat.mic.hold'

async function decodeTo16kMono(buf: ArrayBuffer): Promise<Float32Array> {
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
  const TARGET = 16000
  if (decoded.sampleRate === TARGET) return mono
  const outLen = Math.max(1, Math.ceil((len * TARGET) / decoded.sampleRate))
  const offline = new OfflineAudioContext(1, outLen, TARGET)
  const srcBuf = offline.createBuffer(1, len, decoded.sampleRate)
  srcBuf.getChannelData(0).set(mono)
  const src = offline.createBufferSource()
  src.buffer = srcBuf
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

export function ChatMicButton({
  onTranscribed,
  disabled,
}: {
  onTranscribed: (text: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('chat')
  const [status, setStatus] = useState<Status>('idle')
  const [menuOpen, setMenuOpen] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>(() => localStorage.getItem(DEVICE_KEY) ?? '')
  const [hold, setHold] = useState<boolean>(() => localStorage.getItem(HOLD_KEY) === '1')

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const refreshDevices = useCallback(async () => {
    try {
      let list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')

      if (list.length && list.every((d) => !d.label)) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true })
          s.getTracks().forEach((t) => t.stop())
          list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
        } catch {}
      }
      setDevices(list)
    } catch {
      setDevices([])
    }
  }, [])

  useEffect(() => {
    void refreshDevices()
    const onChange = () => void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
  }, [refreshDevices])

  useEffect(() => {
    if (!menuOpen) return
    void refreshDevices()
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen, refreshDevices])

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  const finish = useCallback(async () => {
    setStatus('transcribing')
    try {
      const rec = recRef.current
      const blob = new Blob(chunksRef.current, { type: rec?.mimeType || 'audio/webm' })
      chunksRef.current = []
      if (blob.size === 0) {
        setStatus('idle')
        return
      }
      const pcm = await decodeTo16kMono(await blob.arrayBuffer())
      const res = await window.api.chatTranscribe(pcm)
      const text = res?.text?.trim()
      if (text) {
        onTranscribed(text)
      } else if (res?.error === 'silent') {
        setStatus('silent')
        setTimeout(() => setStatus((s) => (s === 'silent' ? 'idle' : s)), 4000)
        return
      }
    } catch {
    } finally {
      setStatus((s) => (s === 'transcribing' ? 'idle' : s))
    }
  }, [onTranscribed])

  const start = useCallback(async () => {
    try {
      await window.api.chatEnsureMicAccess().catch(() => {})
      const wanted = deviceId ? { deviceId: { exact: deviceId } } : true
      const stream = await navigator.mediaDevices
        .getUserMedia({ audio: wanted })
        .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }))
      streamRef.current = stream
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        cleanupStream()
        void finish()
      }
      recRef.current = rec
      rec.start()
      setStatus('recording')
    } catch {
      cleanupStream()
      setStatus('idle')
    }
  }, [deviceId, finish])

  const stopRec = useCallback(() => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop()
  }, [])

  // Click toggles normal recording; push-to-talk uses pointer down/up.
  const onMicClick = () => {
    if (hold || disabled || status === 'transcribing') return
    if (status === 'recording') stopRec()
    else void start()
  }
  const onMicPointerDown = (e: React.PointerEvent) => {
    if (!hold || disabled || (status !== 'idle' && status !== 'silent')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    void start()
  }
  const onMicPointerUp = () => {
    if (hold && status === 'recording') stopRec()
  }

  const chooseDevice = (id: string) => {
    setDeviceId(id)
    if (id) localStorage.setItem(DEVICE_KEY, id)
    else localStorage.removeItem(DEVICE_KEY)
    setMenuOpen(false)
  }
  const toggleHold = () => {
    setHold((h) => {
      const next = !h
      localStorage.setItem(HOLD_KEY, next ? '1' : '0')
      return next
    })
  }

  const recording = status === 'recording'
  const busy = status === 'transcribing'
  const silent = status === 'silent'

  return (
    <div ref={wrapRef} className="relative flex items-center">
      <div
        className={cn(
          'flex items-center rounded-full',
          recording
            ? 'bg-red-500/20 text-red-400'
            : silent
              ? 'bg-amber-500/20 text-amber-400'
              : 'text-muted-foreground hover:bg-white/[0.06]'
        )}
      >
        <button
          type="button"
          onClick={onMicClick}
          onPointerDown={onMicPointerDown}
          onPointerUp={onMicPointerUp}
          disabled={disabled || busy}
          title={
            silent
              ? t('mic.silentTitle')
              : hold
                ? t('mic.holdToRecord')
                : recording
                  ? t('mic.stopAndTranscribe')
                  : busy
                    ? t('mic.transcribing')
                    : t('mic.dictate')
          }
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full hover:text-foreground',
            (disabled || busy) && 'opacity-60'
          )}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : recording ? (
            <Square className="h-3.5 w-3.5" />
          ) : silent ? (
            <MicOff className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          title={t('mic.chooseMic')}
          className="flex h-8 w-5 items-center justify-center rounded-full pr-0.5 hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      {menuOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-1 w-80 overflow-hidden rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl">
          <div className="px-2.5 py-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
            {t('mic.microphone')}
          </div>
          {devices.length === 0 && (
            <div className="px-2.5 py-1.5 text-[12px] text-muted-foreground">{t('mic.noMicFound')}</div>
          )}
          {devices.map((d, i) => {
            const active = d.deviceId === deviceId || (!deviceId && d.deviceId === 'default')
            return (
              <button
                key={d.deviceId || i}
                type="button"
                onClick={() => chooseDevice(d.deviceId === 'default' ? '' : d.deviceId)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-white/[0.05]"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {d.label || t('mic.micFallback', { index: i + 1 })}
                </span>
                <Check className={cn('h-3.5 w-3.5 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
              </button>
            )
          })}
          <div className="my-1 border-t border-white/[0.08]" />
          <button
            type="button"
            onClick={toggleHold}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-white/[0.05]"
          >
            <span className="min-w-0 flex-1 text-[13px] text-foreground">{t('mic.holdToRecord')}</span>
            <span
              className={cn(
                'flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors',
                hold ? 'bg-indigo-500' : 'bg-white/[0.15]'
              )}
            >
              <span className={cn('h-3 w-3 rounded-full bg-white transition-transform', hold && 'translate-x-3')} />
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
