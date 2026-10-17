import { useChatDocument } from '@/lib/chat-window-context'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Check, Loader2, Mic, MicOff, SlidersHorizontal, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dictationLanguage, type AsrSupport, type DictationLanguageMode } from '../../../shared/asr'
import type { RuntimeAssetInfo } from '../../../shared/runtime-assets'
import { MIC_LANGUAGE_KEY, readLanguageMode } from '@/lib/dictation'
import { DictationModelCard } from './DictationModelCard'
import { DictationLevels, RecordingClock } from './DictationMeter'
import { dictationShortcut, useComposerDictation, WorkingRing, type DictationFinish } from './composer-dictation'
import { hostApi } from '@/lib/hosts/host-context'
import { LOCAL_HOST_ID } from '../../../shared/host-key'
import { formatAccelerator } from '../../../shared/shortcuts'

// Dictation runs on this computer, where the microphone is, whichever host the chat belongs to.
const localApi = hostApi(LOCAL_HOST_ID)

type Status = 'idle' | 'recording' | 'transcribing' | 'silent' | 'error'
type StartedBy = 'click' | 'hold' | 'shortcut'

const DEVICE_KEY = 'chat.mic.deviceId'
const HOLD_KEY = 'chat.mic.hold'

const barIconCls =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-white/[0.06] hover:text-foreground'

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

function Switch({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors',
        on ? 'bg-indigo-500' : 'bg-white/[0.15]'
      )}
    >
      <span className={cn('h-3 w-3 rounded-full bg-white transition-transform', on && 'translate-x-3')} />
    </span>
  )
}

/**
 * Microphone control shared by the chat and bot composers. Speech is transcribed locally by whisper.cpp. While it
 * records or transcribes, the control takes over the composer's action bar, and each recording ends one of three
 * ways: discarded, added to the draft (`onTranscribed`), or sent with the draft (`onSendDictation`, which returns
 * false when the composer cannot send right now, so the text goes to the draft instead).
 */
export function ChatMicButton({
  onTranscribed,
  onSendDictation,
  disabled,
}: {
  onTranscribed: (text: string) => void
  /** Sends the draft with the transcription; returns false when the composer cannot send. */
  onSendDictation?: (text: string) => boolean
  disabled?: boolean
}) {
  const ownerDocument = useChatDocument()
  const dictation = useComposerDictation()
  const { t, i18n } = useTranslation('chat')
  const [status, setStatus] = useState<Status>('idle')
  // What the transcription in progress will do with its text.
  const [pending, setPending] = useState<'insert' | 'send'>('insert')
  const [session, setSession] = useState<{ stream: MediaStream; startedAt: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>(() => localStorage.getItem(DEVICE_KEY) ?? '')
  const [hold, setHold] = useState<boolean>(() => localStorage.getItem(HOLD_KEY) === '1')
  const [languageMode, setLanguageMode] = useState<DictationLanguageMode>(() => readLanguageMode(localStorage))
  const [support, setSupport] = useState<AsrSupport | null>(null)
  const [model, setModel] = useState<RuntimeAssetInfo | null>(null)
  const [cardOpen, setCardOpen] = useState(false)
  const [preparing, setPreparing] = useState(false)

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusRef = useRef(status)
  statusRef.current = status
  const dictationRef = useRef(dictation)
  dictationRef.current = dictation
  // How the current recording ends. The transcription reads it once the text is ready, so Enter pressed while it
  // transcribes still turns an insert into a send.
  const finishRef = useRef<DictationFinish>('insert')
  // Bumped to drop a transcription that was cancelled or outlived the control.
  const transcriptionRef = useRef(0)
  const startingRef = useRef(false)
  // Hold to record: whether the pointer is still down, and whether the current recording came from holding it.
  const holdingRef = useRef(false)
  const holdSessionRef = useRef(false)
  // rec.onstop runs the finish() captured when recording started, so it reads the latest props and choices here.
  const latest = useRef({ onTranscribed, onSendDictation, languageMode, model, support, cardOpen })
  latest.current = { onTranscribed, onSendDictation, languageMode, model, support, cardOpen }

  const flashStatus = useCallback((next: 'silent' | 'error', ms: number) => {
    setStatus(next)
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => setStatus((s) => (s === next ? 'idle' : s)), ms)
  }, [])

  useEffect(() => {
    let alive = true
    void window.api
      .chatAsrSupport()
      .then((next) => alive && setSupport(next))
      .catch(() => {})
    void localApi
      .runtimeAssetStatus('whisper-model')
      .then((next) => alive && setModel(next))
      .catch(() => {})
    const unsubscribe = localApi.onRuntimeAssetChanged((info) => {
      if (info.id === 'whisper-model') setModel(info)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  // Right after the model finishes installing from the card, load it so the first dictation is fast; the first
  // load on macOS also compiles the Metal shaders.
  const modelState = model?.status.state
  const previousModelState = useRef(modelState)
  useEffect(() => {
    const previous = previousModelState.current
    previousModelState.current = modelState
    if (modelState !== 'ready' || previous === undefined || previous === 'ready' || !latest.current.cardOpen) return
    let alive = true
    setPreparing(true)
    void window.api
      .chatAsrWarm()
      .catch(() => false)
      .finally(() => alive && setPreparing(false))
    return () => {
      alive = false
    }
  }, [modelState])

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
    // Esc closes only the menu: it must not also discard the recording or stop the agent.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setMenuOpen(false)
    }
    ownerDocument.addEventListener('mousedown', onDoc)
    ownerDocument.addEventListener('keydown', onKey, true)
    return () => {
      ownerDocument.removeEventListener('mousedown', onDoc)
      ownerDocument.removeEventListener('keydown', onKey, true)
    }
  }, [ownerDocument, menuOpen, refreshDevices])

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  const finish = useCallback(async () => {
    holdSessionRef.current = false
    const rec = recRef.current
    const blob = new Blob(chunksRef.current, { type: rec?.mimeType || 'audio/webm' })
    chunksRef.current = []
    setSession(null)
    const how = finishRef.current
    if (how === 'discard' || blob.size === 0) {
      setStatus('idle')
      return
    }
    const id = ++transcriptionRef.current
    setPending(how)
    setStatus('transcribing')
    try {
      const pcm = await decodeTo16kMono(await blob.arrayBuffer())
      if (id !== transcriptionRef.current) return
      const res = await window.api.chatTranscribe(pcm, {
        language: dictationLanguage(latest.current.languageMode, i18n.resolvedLanguage || i18n.language),
      })
      if (id !== transcriptionRef.current) return
      const text = res?.text?.trim()
      if (text) {
        const { onSendDictation: send, onTranscribed: insert } = latest.current
        if (!(finishRef.current === 'send' && send?.(text))) insert(text)
      } else if (res?.error === 'silent') {
        flashStatus('silent', 4000)
      } else if (res?.error === 'model-missing') {
        setCardOpen(true)
      } else if (res?.error) {
        flashStatus('error', 6000)
      }
    } catch (error) {
      if (id !== transcriptionRef.current) return
      console.error('[mic] dictation failed', error)
      flashStatus('error', 6000)
    } finally {
      if (id === transcriptionRef.current) setStatus((s) => (s === 'transcribing' ? 'idle' : s))
    }
  }, [flashStatus, i18n])

  const start = useCallback(
    async (by: StartedBy) => {
      if (startingRef.current || (recRef.current && recRef.current.state !== 'inactive')) return
      const { support: currentSupport, model: currentModel } = latest.current
      if (currentSupport?.supported === false) return
      setMenuOpen(false)
      if (currentModel?.status.state !== 'ready') {
        setCardOpen(true)
        return
      }
      setCardOpen(false)
      // Load the engine while the user speaks; it is a no-op once loaded.
      void window.api.chatAsrWarm().catch(() => false)
      startingRef.current = true
      try {
        await window.api.chatEnsureMicAccess().catch(() => {})
        const wanted = deviceId ? { deviceId: { exact: deviceId } } : true
        const stream = await navigator.mediaDevices
          .getUserMedia({ audio: wanted })
          .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }))
        if (by === 'hold' && !holdingRef.current) {
          // Released before the microphone opened.
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        const rec = new MediaRecorder(stream)
        chunksRef.current = []
        finishRef.current = 'insert'
        holdSessionRef.current = by === 'hold'
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
        setSession({ stream, startedAt: Date.now() })
        // The microphone button gives way to the recording bar; the editor keeps Enter and Esc working.
        if (by !== 'shortcut') dictationRef.current?.focusEditor()
      } catch {
        cleanupStream()
        setStatus('idle')
      } finally {
        startingRef.current = false
      }
    },
    [deviceId, finish]
  )

  const finishDictation = useCallback((how: DictationFinish) => {
    const rec = recRef.current
    if (rec && rec.state !== 'inactive') {
      finishRef.current = how
      rec.stop()
    } else if (statusRef.current === 'transcribing') {
      if (how === 'discard') {
        transcriptionRef.current++
        setStatus('idle')
      } else {
        finishRef.current = how
        setPending(how)
      }
    }
  }, [])

  const unsupported = support?.supported === false
  const recording = status === 'recording'
  const transcribing = status === 'transcribing'
  const active = recording || transcribing
  const silent = status === 'silent'
  const failed = status === 'error'

  useEffect(() => {
    dictationRef.current?.onActiveChange(active)
  }, [active])

  useEffect(() => {
    if (!dictation) return
    const control = {
      active,
      toggle: () => {
        if (statusRef.current === 'recording') finishDictation('insert')
        else if (statusRef.current !== 'transcribing' && !disabled && !unsupported) void start('shortcut')
      },
      finish: finishDictation,
    }
    dictation.control.current = control
    return () => {
      if (dictation.control.current === control) dictation.control.current = null
    }
  })

  // Leaving the composer drops the recording rather than keeping the microphone open.
  useEffect(
    () => () => {
      transcriptionRef.current++
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
      const rec = recRef.current
      if (rec && rec.state !== 'inactive') {
        finishRef.current = 'discard'
        rec.stop()
      }
      streamRef.current?.getTracks().forEach((track) => track.stop())
      dictationRef.current?.onActiveChange(false)
    },
    []
  )

  // The microphone button is gone once the recording bar replaces it, so the release is caught on the document.
  useEffect(() => {
    if (!hold) return
    const release = () => {
      if (!holdingRef.current) return
      holdingRef.current = false
      if (holdSessionRef.current) finishDictation('insert')
    }
    ownerDocument.addEventListener('pointerup', release)
    ownerDocument.addEventListener('pointercancel', release)
    return () => {
      ownerDocument.removeEventListener('pointerup', release)
      ownerDocument.removeEventListener('pointercancel', release)
    }
  }, [hold, ownerDocument, finishDictation])

  const ready = status === 'idle' || silent || failed
  const onMicClick = () => {
    if (hold || disabled || unsupported || !ready) return
    void start('click')
  }
  const onMicPointerDown = (e: React.PointerEvent) => {
    if (!hold || e.button !== 0 || disabled || unsupported || !ready) return
    holdingRef.current = true
    void start('hold')
  }
  const toggleMenu = () => {
    setCardOpen(false)
    setMenuOpen((open) => !open)
  }
  const onMicContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    toggleMenu()
  }
  const onBarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || !active) return
    e.preventDefault()
    e.stopPropagation()
    finishDictation('discard')
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
  const chooseLanguage = (mode: DictationLanguageMode) => {
    setLanguageMode(mode)
    localStorage.setItem(MIC_LANGUAGE_KEY, mode)
  }
  const closeCard = useCallback(() => setCardOpen(false), [])

  const title = unsupported
    ? t(support.reason === 'os-version' ? 'mic.unsupportedOs' : 'mic.unsupportedPlatform')
    : failed
      ? t('mic.unavailableTitle')
      : silent
        ? t('mic.silentTitle')
        : hold
          ? t('mic.holdHint')
          : t('mic.dictateHint', {
              shortcut: formatAccelerator(dictationShortcut(window.api.platformInfo.os), window.api.platformInfo.os),
            })
  const queues = dictation?.queues ?? false
  const sendTitle = queues ? t('mic.stopAndQueue') : t('mic.stopAndSend')

  return (
    <div
      ref={wrapRef}
      className={cn('relative flex items-center', active && 'min-w-0 flex-1')}
      onKeyDown={onBarKeyDown}
    >
      {recording && session ? (
        <div className="@container flex min-w-0 flex-1 items-center gap-1.5">
          <button
            type="button"
            onClick={() => finishDictation('discard')}
            title={t('mic.discard')}
            aria-label={t('mic.discard')}
            aria-keyshortcuts="Escape"
            className={barIconCls}
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-red-500/[0.12] px-3">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500 motion-reduce:animate-none"
            />
            <DictationLevels stream={session.stream} className="h-5 min-w-0 flex-1 text-red-400" />
            <RecordingClock startedAt={session.startedAt} className="shrink-0 text-[12px] tabular-nums text-red-300" />
          </div>
          <button
            type="button"
            onClick={toggleMenu}
            title={t('mic.options')}
            aria-label={t('mic.options')}
            aria-expanded={menuOpen}
            className={barIconCls}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => finishDictation('insert')}
            title={t('mic.insertTitle')}
            aria-label={t('mic.insertTitle')}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.07] px-3 text-[12px] text-foreground hover:bg-white/[0.12] @max-[22rem]:px-2"
          >
            <Check className="h-3.5 w-3.5" />
            <span className="@max-[22rem]:hidden">{t('mic.insert')}</span>
          </button>
          <button
            type="button"
            onClick={() => finishDictation('send')}
            title={sendTitle}
            aria-label={sendTitle}
            aria-keyshortcuts="Enter"
            className="chat-send-button relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-white transition-[color,background,box-shadow,transform] hover:bg-indigo-400"
          >
            <WorkingRing active={dictation?.streaming ?? false} />
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      ) : transcribing ? (
        <div
          role="status"
          className="flex h-8 min-w-0 flex-1 items-center gap-2.5 pl-1 text-[13px] text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-indigo-300" />
          <span className="min-w-0 flex-1 truncate">
            {pending === 'send'
              ? queues
                ? t('mic.transcribingQueue')
                : t('mic.transcribingSend')
              : t('mic.transcribing')}
          </span>
          <button
            type="button"
            onClick={() => finishDictation('discard')}
            title={t('mic.cancelTranscription')}
            aria-label={t('mic.cancelTranscription')}
            className={barIconCls}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onMicClick}
          onPointerDown={onMicPointerDown}
          onContextMenu={onMicContextMenu}
          disabled={disabled || unsupported}
          title={title}
          aria-label={title}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full hover:text-foreground',
            silent || failed ? 'bg-amber-500/20 text-amber-400' : 'text-muted-foreground hover:bg-white/[0.06]',
            (disabled || unsupported) && 'opacity-60'
          )}
        >
          {silent || failed || unsupported ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>
      )}

      {cardOpen && (
        <DictationModelCard
          info={model}
          preparing={preparing}
          onInfo={setModel}
          onClose={closeCard}
          boundary={wrapRef}
        />
      )}

      {menuOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl">
          <div className="px-2.5 py-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
            {t('mic.microphone')}
          </div>
          {devices.length === 0 && (
            <div className="px-2.5 py-1.5 text-[12px] text-muted-foreground">{t('mic.noMicFound')}</div>
          )}
          {devices.map((d, i) => {
            const selected = d.deviceId === deviceId || (!deviceId && d.deviceId === 'default')
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
                <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
              </button>
            )
          })}
          <div className="my-1 border-t border-white/[0.08]" />
          <button
            type="button"
            role="switch"
            aria-checked={hold}
            onClick={toggleHold}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-white/[0.05]"
          >
            <span className="min-w-0 flex-1 text-[13px] text-foreground">{t('mic.holdToRecord')}</span>
            <Switch on={hold} />
          </button>
          <div className="my-1 border-t border-white/[0.08]" />
          <div className="px-2.5 py-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
            {t('mic.language')}
          </div>
          {(['app', 'auto'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={languageMode === mode}
              onClick={() => chooseLanguage(mode)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-white/[0.05]"
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {t(mode === 'app' ? 'mic.languageApp' : 'mic.languageAuto')}
              </span>
              <Check className={cn('h-3.5 w-3.5 shrink-0', languageMode === mode ? 'opacity-100' : 'opacity-0')} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
