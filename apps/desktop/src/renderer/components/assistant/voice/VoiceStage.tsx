import { type RefObject, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  Check,
  Clock,
  Keyboard,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Square,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { plainLabel, toolLabel } from '@/components/chat/AgentActivity'
import { Button } from '@/components/ui/button'
import { baseToolName, chatToolStep } from '@/lib/agent-activity'
import { hostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import { LOCAL_HOST_ID } from '../../../../shared/host-key'
import type { PendingChatQuestion } from '../../../../shared/chat'
import type { VoiceCallEnd, VoiceSession } from './use-voice-session'
import { captionTicking, captionView, type VoiceCaption } from './voice-caption'
import type { VoiceActivityItem } from './voice-activity'
import { useElapsed } from './VoiceButton'
import { type StaffMode, VoiceStaff } from './VoiceStaff'

/**
 * The assistant window while the person talks to it: the voice itself, what was said last, what the assistant does
 * about it and what it needs, with the conversation one key away. The chat stays underneath, the same conversation.
 */

type Phase =
  | 'connecting'
  | 'speaking'
  | 'hearing'
  | 'listening'
  | 'muted'
  | 'transcribing'
  | 'working'
  | 'thinking'
  | 'answer'
  | 'ready'
  | 'error'

function phaseOf(session: VoiceSession): Phase {
  const { state, call, question } = session
  if (call === 'connecting') return 'connecting'
  if (state === 'speaking') return 'speaking'
  const working = session.activity.items.some((item) => item.status === 'running')
  if (call) {
    if (session.personSpeaking && !session.muted) return 'hearing'
    if (session.muted) return 'muted'
    if (state === 'thinking') return working ? 'working' : 'thinking'
    return question ? 'answer' : 'listening'
  }
  if (state === 'listening') return 'hearing'
  if (state === 'transcribing') return 'transcribing'
  if (state === 'thinking') return working ? 'working' : 'thinking'
  if (state === 'error') return 'error'
  return question ? 'answer' : 'ready'
}

const STAFF: Record<Phase, StaffMode> = {
  connecting: 'connecting',
  speaking: 'speaking',
  hearing: 'listening',
  listening: 'listening',
  answer: 'listening',
  ready: 'listening',
  muted: 'muted',
  transcribing: 'thinking',
  working: 'thinking',
  thinking: 'thinking',
  error: 'error',
}

/** During a call the server says when the person talks; tap to talk only knows how loud the microphone is. */
const staffMode = (session: VoiceSession, phase: Phase): StaffMode =>
  phase === 'hearing' && session.call ? 'hearing' : STAFF[phase]

/** The call is over (or never started) in Realtime mode: the screen shows how it ended. */
const callOver = (session: VoiceSession) => session.mode === 'realtime' && !session.call

/** Redraws on a clock while `active`. */
function useNow(active: boolean, every = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [active, every])
  return active ? now : Date.now()
}

// ---------- the activity's labels ----------

/** The assistant's own tools, said the way the person thinks of them. */
const VOICE_TOOLS = new Set([
  'maestrly_overview',
  'bot_read',
  'bot_send',
  'respond_pending',
  'list_conversations',
  'read_conversation',
  'wait_conversation',
  'send_to_conversation',
  'start_conversations',
  'ask_assistant',
  'answer_confirmation',
])

const text = (value: unknown, max = 80): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max - 1).trimEnd() + '…' : trimmed
}

export function activityLabel(item: VoiceActivityItem, t: TFunction, tChat: TFunction): string {
  const name = baseToolName(item.toolName)
  const tense = item.status === 'running' || item.status === 'waiting' ? 'live' : 'done'
  if (VOICE_TOOLS.has(name)) {
    const input = (item.input ?? {}) as Record<string, unknown>
    const request = name === 'ask_assistant' ? text(input.request) : null
    const option = name === 'answer_confirmation' ? text(input.option, 40) : null
    if (request) return t(`assistant.voice.stage.tool.${name}.${tense}Request`, { request })
    if (option) return t(`assistant.voice.stage.tool.${name}.${tense}Option`, { option })
    return t(`assistant.voice.stage.tool.${name}.${tense}`)
  }
  const part = {
    type: 'tool' as const,
    id: item.id,
    toolCallId: item.id,
    toolName: item.toolName,
    input: item.input,
    state: item.state ?? { status: 'running' as const },
  }
  return plainLabel(toolLabel(tChat, chatToolStep(part, true), tense))
}

function seconds(ms: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(ms / 1000)} s`
}

function StatusGlyph({ status }: { status: VoiceActivityItem['status'] }) {
  if (status === 'running')
    return (
      <span
        aria-hidden="true"
        className="size-3 animate-spin rounded-full border-[1.5px] border-foreground/20 border-t-foreground"
      />
    )
  const icons: Record<Exclude<VoiceActivityItem['status'], 'running'>, LucideIcon> = {
    waiting: Clock,
    done: Check,
    failed: TriangleAlert,
    cancelled: X,
  }
  const Icon = icons[status]
  return (
    <Icon
      aria-hidden="true"
      strokeWidth={2.2}
      className={cn(
        'size-3.5',
        status === 'done' && 'text-status-ready',
        status === 'waiting' && 'text-[var(--voice-you)]',
        status === 'failed' && 'text-destructive',
        status === 'cancelled' && 'text-muted-foreground'
      )}
    />
  )
}

function ActivityList({ items, onOpenConversation }: { items: VoiceActivityItem[]; onOpenConversation(): void }) {
  const { t, i18n } = useTranslation('ui')
  const { t: tChat } = useTranslation('chat')
  const recent = items.slice(-3)
  const now = useNow(recent.some((item) => item.status === 'running'))
  if (!recent.length) return null
  return (
    <ol aria-label={t('assistant.voice.stage.activity')} className="mx-auto mt-5 w-full max-w-[372px] text-left">
      {recent.map((item) => {
        const label = activityLabel(item, t, tChat)
        const took = (item.endedAt ?? now) - item.startedAt
        return (
          <li
            key={item.id}
            data-status={item.status}
            className={cn(
              'voice-rise grid min-h-[30px] grid-cols-[16px_1fr_auto] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-foreground/75',
              item.status === 'running' && 'bg-white/[0.035] text-foreground'
            )}
          >
            <span className="grid size-4 place-items-center">
              <StatusGlyph status={item.status} />
            </span>
            <span
              className={cn('min-w-0 truncate', item.status === 'cancelled' && 'text-muted-foreground')}
              title={label}
            >
              {label}
            </span>
            {item.status === 'waiting' ? (
              <button
                type="button"
                onClick={onOpenConversation}
                className="rounded px-1.5 text-[11px] text-[var(--voice-you)] hover:bg-white/[0.06]"
              >
                {t('assistant.voice.stage.waiting')}
              </button>
            ) : (
              <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
                {item.status === 'running' || item.status === 'done'
                  ? seconds(Math.max(0, took), i18n.language)
                  : t(`assistant.voice.stage.status.${item.status}`)}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

// ---------- the card that waits for the person ----------

const firstParagraph = (value: string) =>
  value
    .split(/\n\s*\n/)[0]
    .replace(/[*_`#>]+/g, '')
    .trim()

function ConfirmCard({
  question,
  voiceAnswers,
  onOpenConversation,
}: {
  question: PendingChatQuestion
  /** The voice listens for one of the options. */
  voiceAnswers: boolean
  onOpenConversation(): void
}) {
  const { t, i18n } = useTranslation('ui')
  const [sent, setSent] = useState<string | null>(null)
  useEffect(() => setSent(null), [question.toolCallId])
  const [only, ...rest] = question.questions
  const simple = !!only && !rest.length && !only.multiSelect && !only.isSecret && only.options.length > 0
  const said =
    simple && voiceAnswers && !only.clickOnly
      ? new Intl.ListFormat(i18n.language, { type: 'disjunction' }).format(
          only.options.map((option) => `“${option.label.toLowerCase()}”`)
        )
      : null
  return (
    <div className="voice-rise mx-auto mt-5 w-full max-w-[372px] rounded-xl bg-white/[0.04] px-3.5 pb-3 pt-3.5 text-left shadow-[0_0_0_0.5px_var(--border-strong)]">
      <p className="text-[14.5px] font-medium leading-snug">{firstParagraph(only?.question ?? only?.header ?? '')}</p>
      {simple ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {only.options.map((option, index) => (
              <Button
                key={option.label}
                size="sm"
                variant={index === 0 ? 'default' : 'secondary'}
                disabled={sent !== null}
                className={cn(sent !== null && sent !== option.label && 'opacity-30')}
                title={option.description}
                onClick={() => {
                  setSent(option.label)
                  hostApi(LOCAL_HOST_ID).chatQuestionRespond(question.toolCallId, [[option.label]])
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {said && <Mic aria-hidden="true" className="size-3 text-[var(--voice-you)]" />}
            {said ? t('assistant.voice.stage.confirm.say', { options: said }) : t('assistant.voice.stage.confirm.tap')}
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-[12px] text-muted-foreground">{t('assistant.voice.stage.confirm.inConversation')}</p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={onOpenConversation}>
            {t('assistant.voice.stage.confirm.open')}
          </Button>
        </>
      )}
    </div>
  )
}

// ---------- caption ----------

function Caption({ caption, phase, size }: { caption: VoiceCaption | null; phase: Phase; size: 'full' | 'line' }) {
  const now = useNow(captionTicking(caption, Date.now()), 80)
  if (!caption) return size === 'full' ? <p aria-hidden="true" className="min-h-[1.32em] text-[22px]" /> : null
  const view = captionView(caption, now)
  const current =
    caption.streaming ||
    (caption.who === 'voice' ? phase === 'speaking' : phase === 'hearing' || phase === 'transcribing')
  if (size === 'line')
    return <span className="block truncate text-[13px] text-foreground/75">{view.words.join(' ')}</span>
  return (
    <p
      aria-hidden="true"
      data-who={caption.who}
      className={cn(
        'mx-auto max-w-[400px] text-balance text-[22px] font-medium leading-[1.32] tracking-[-0.012em] transition-opacity duration-500',
        !current && 'opacity-50',
        // What the person said stays bright a moment before it steps back.
        !current && caption.who === 'you' && 'delay-1000'
      )}
    >
      {view.clipped && <span className="text-foreground/25">… </span>}
      {view.words.map((word, index) => (
        <span
          key={`${caption.startedAt}:${index}`}
          className={cn(
            'transition-colors duration-200',
            caption.streaming && 'voice-word-in',
            index < view.lit
              ? caption.who === 'you'
                ? 'text-[var(--voice-you-ink)]'
                : 'text-foreground'
              : 'text-foreground/25'
          )}
        >
          {index ? ' ' : ''}
          {word}
        </span>
      ))}
    </p>
  )
}

/** What a screen reader hears: each line once it is complete. */
function SpokenAloud({ caption }: { caption: VoiceCaption | null }) {
  const { t } = useTranslation('ui')
  const said =
    caption && !caption.streaming
      ? `${t(caption.who === 'you' ? 'assistant.voice.stage.you' : 'assistant.voice.stage.assistant')}: ${caption.text}`
      : ''
  return (
    <p className="sr-only" aria-live="polite">
      {said}
    </p>
  )
}

// ---------- controls ----------

/** The main button: tap to talk (agent mode), or the call's microphone (Realtime). */
export function mainAction(session: VoiceSession) {
  if (session.call) {
    if (session.call !== 'connecting') session.setMuted(!session.muted)
    return
  }
  session.tap()
}

function useMicRing(session: VoiceSession, ref: RefObject<HTMLElement | null>) {
  const open = session.call ? session.call !== 'connecting' && !session.muted : session.state === 'listening'
  const levels = session.levels
  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (!open) {
      element.style.setProperty('--voice-level', '0')
      return
    }
    let frame = 0
    let level = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      const target = Math.min(1, levels().input * 7)
      level += (target - level) * (target > level ? 0.4 : 0.12)
      element.style.setProperty('--voice-level', level.toFixed(3))
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [open, levels, ref])
  return open
}

function MainButton({ session, compact = false }: { session: VoiceSession; compact?: boolean }) {
  const { t } = useTranslation('ui')
  const ref = useRef<HTMLButtonElement>(null)
  const ring = useMicRing(session, ref)
  const { state, call, muted } = session
  let icon: LucideIcon = Mic
  let label: string
  let solid = false
  let busy = false
  let disabled = false
  if (call) {
    if (call === 'connecting') {
      label = t('assistant.voice.stage.connecting')
      disabled = true
    } else if (muted) {
      icon = MicOff
      solid = true
      label = t('assistant.voice.stage.micOn')
    } else label = t('assistant.voice.stage.micOff')
  } else if (state === 'listening') label = t('assistant.voice.stage.stopListening')
  else if (state === 'speaking') {
    icon = Square
    label = t('assistant.voice.stage.stopReading')
  } else if (state === 'thinking') {
    icon = Loader2
    busy = true
    label = t('assistant.voice.stage.notRead')
  } else if (state === 'transcribing') {
    icon = Loader2
    busy = true
    disabled = true
    label = t('assistant.voice.transcribing')
  } else {
    solid = true
    label = t('assistant.voice.stage.talk')
  }
  const Icon = icon
  return (
    <button
      ref={ref}
      type="button"
      data-voice-main={call ? (muted ? 'muted' : 'live') : state}
      aria-label={label}
      title={label}
      aria-pressed={call ? muted : undefined}
      disabled={disabled}
      onClick={() => mainAction(session)}
      className={cn(
        'relative grid shrink-0 place-items-center rounded-full transition-[background-color,color,transform] duration-200 active:scale-95 disabled:opacity-45',
        compact ? 'size-8' : 'size-16',
        solid
          ? 'bg-primary text-primary-foreground hover:bg-white'
          : 'bg-white/[0.07] text-foreground hover:bg-white/[0.11]',
        !compact && solid && !call && session.caption && 'voice-beckon'
      )}
    >
      {ring && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            boxShadow:
              '0 0 0 1px rgb(242 180 92 / calc(0.3 + var(--voice-level, 0) * 0.5)), 0 0 0 calc(2px + var(--voice-level, 0) * 9px) rgb(242 180 92 / calc(0.06 + var(--voice-level, 0) * 0.2))',
          }}
        />
      )}
      <Icon aria-hidden="true" className={cn(compact ? 'size-4' : 'size-[22px]', busy && 'animate-spin')} />
    </button>
  )
}

function EndButton({ session, onExit, compact = false }: { session: VoiceSession; onExit(): void; compact?: boolean }) {
  const { t } = useTranslation('ui')
  const call = session.mode === 'realtime'
  const label = t(call ? 'assistant.voice.stage.hangUp' : 'assistant.voice.stage.exit')
  const Icon = call ? PhoneOff : X
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={call ? session.hangUp : onExit}
      className={cn(
        'grid shrink-0 place-items-center rounded-full transition-colors',
        compact ? 'size-8' : 'size-11',
        call
          ? 'bg-destructive/15 text-destructive hover:bg-destructive/25'
          : 'bg-white/[0.06] text-foreground/75 hover:bg-white/[0.1] hover:text-foreground'
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  )
}

// ---------- the call's end ----------

const SETTINGS_REASONS = new Set<VoiceCallEnd['reason']>(['key-missing', 'key-rejected'])
const REASON_KEY: Record<VoiceCallEnd['reason'], string> = {
  hangup: 'hangup',
  idle: 'idle',
  network: 'network',
  error: 'error',
  mic: 'mic',
  'key-missing': 'keyMissing',
  'key-rejected': 'keyRejected',
  'bad-offer': 'badOffer',
}

function CallEnded({
  session,
  onShowChat,
  onOpenSettings,
}: {
  session: VoiceSession
  onShowChat(): void
  onOpenSettings(): void
}) {
  const { t } = useTranslation('ui')
  const { t: tChat } = useTranslation('chat')
  const end = session.callEnd
  const key = end ? REASON_KEY[end.reason] : 'ready'
  const connected = end?.startedAt != null
  const failed = !!end && !['hangup', 'idle'].includes(end.reason)
  const done = connected ? session.activity.done : []
  const duration = connected ? formatClock(end.endedAt - (end.startedAt ?? end.endedAt)) : null
  const prefix = 'assistant.voice.stage.ended'
  const title = !end ? t(`${prefix}.ready`) : failed ? t(`${prefix}.${key}`) : t(`${prefix}.title`)
  const detail = !end ? t(`${prefix}.readyDesc`) : failed ? t(`${prefix}.${key}Desc`) : t(`${prefix}.${key}`)
  return (
    <div className="voice-rise px-8 pb-10 text-center">
      {failed && (
        <div className="mx-auto mb-3 grid size-9 place-items-center rounded-full bg-destructive/12 text-destructive">
          {end.reason === 'mic' ? <MicOff className="size-4" /> : <TriangleAlert className="size-4" />}
        </div>
      )}
      <h2 className="text-[21px] font-semibold tracking-[-0.012em]">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-[330px] text-[12.5px] leading-snug text-muted-foreground">
        {duration && (
          <>
            <span className="font-mono tabular-nums">{duration}</span>
            {' · '}
            {t('assistant.voice.stage.ended.actions', { count: done.length })}
            {' · '}
          </>
        )}
        {detail}
      </p>
      {done.length > 0 && (
        <ul className="mx-auto mt-4 max-w-[340px] text-left">
          {done.slice(-4).map((item) => (
            <li key={item.id} className="flex items-center gap-2 py-1 text-[12.5px] text-foreground/75">
              <Check aria-hidden="true" strokeWidth={2.2} className="size-3.5 shrink-0 text-status-ready" />
              <span className="truncate">{activityLabel(item, t, tChat)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6 flex justify-center gap-2">
        {end && SETTINGS_REASONS.has(end.reason) ? (
          <Button variant="secondary" onClick={onOpenSettings}>
            {t('assistant.voice.stage.ended.settings')}
          </Button>
        ) : (
          <Button variant="secondary" onClick={onShowChat}>
            {t('assistant.voice.stage.ended.showConversation')}
          </Button>
        )}
        <Button data-voice-redial onClick={session.tap}>
          <Phone />
          {t(end ? 'assistant.voice.stage.ended.redial' : 'assistant.voice.stage.ended.call')}
        </Button>
      </div>
    </div>
  )
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function IdleWarning({ closesAt, onKeep }: { closesAt: number; onKeep(): void }) {
  const { t } = useTranslation('ui')
  const now = useNow(true, 250)
  return (
    <div className="voice-rise mx-auto mt-4 w-full max-w-[372px] rounded-xl bg-[var(--voice-you)]/[0.08] px-3.5 py-3 text-left shadow-[0_0_0_0.5px_rgb(242_180_92/0.25)]">
      <p className="text-[13px] leading-snug text-foreground/75">
        {t('assistant.voice.stage.idle.text', { time: formatClock(Math.max(0, closesAt - now) + 999) })}
      </p>
      <Button size="sm" variant="secondary" className="mt-2.5" onClick={onKeep}>
        {t('assistant.voice.stage.idle.keep')}
      </Button>
    </div>
  )
}

// ---------- the screens ----------

const EYEBROW_TONE: Partial<Record<Phase, string>> = {
  hearing: 'text-[var(--voice-you)]',
  speaking: 'text-foreground',
  error: 'text-destructive',
}

function hintOf(session: VoiceSession, phase: Phase): string | null {
  if (session.notice) return `assistant.voice.notice.${session.notice}`
  if (phase === 'muted') return 'assistant.voice.stage.hint.muted'
  if (phase === 'listening' && !session.caption) return 'assistant.voice.stage.hint.callReady'
  if (phase === 'ready' && !session.caption) return 'assistant.voice.stage.hint.ready'
  if (phase === 'ready' && session.caption?.who === 'you' && !session.reads)
    return 'assistant.voice.stage.hint.inConversation'
  if (phase === 'ready' || phase === 'error') return 'assistant.voice.stage.hint.again'
  return null
}

export interface VoiceScreenActions {
  /** Shows the conversation; `write` puts the cursor in its composer. */
  onOpenConversation(write?: boolean): void
  /** Leaves the voice screen for the chat (agent mode). */
  onExit(): void
  onOpenSettings(): void
}

export function VoiceStage({
  session,
  onOpenConversation,
  onExit,
  onOpenSettings,
}: { session: VoiceSession } & VoiceScreenActions) {
  const { t } = useTranslation('ui')
  const phase = phaseOf(session)
  const over = callOver(session)
  const hint = over ? null : hintOf(session, phase)
  const staff: StaffMode = over
    ? session.callEnd && !['hangup', 'idle'].includes(session.callEnd.reason)
      ? 'error'
      : 'off'
    : staffMode(session, phase)
  const voiceAnswers = session.mode === 'realtime' || session.reads
  return (
    <section
      aria-label={t('assistant.voice.stage.label')}
      data-voice-stage={over ? 'ended' : phase}
      className="grid h-full grid-rows-[minmax(96px,1fr)_auto_auto] bg-[var(--voice-canvas)]"
    >
      <div className="relative min-h-24">
        <VoiceStaff mode={staff} levels={session.levels} className="absolute inset-0 size-full" />
      </div>
      {over ? (
        <CallEnded session={session} onShowChat={onExit} onOpenSettings={onOpenSettings} />
      ) : (
        <>
          <div className="min-h-0 px-8 text-center">
            <p
              role="status"
              className={cn(
                'mb-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground transition-colors',
                EYEBROW_TONE[phase]
              )}
            >
              {t(`assistant.voice.stage.phase.${phase}`)}
            </p>
            <Caption caption={session.caption} phase={phase} size="full" />
            <SpokenAloud caption={session.caption} />
            {hint && (
              <p
                className={cn(
                  'mx-auto mt-3 max-w-[330px] text-[13px] leading-snug text-muted-foreground',
                  session.notice && 'text-foreground/80'
                )}
              >
                {t(hint)}
              </p>
            )}
            {session.call && phase === 'speaking' && (
              <button
                type="button"
                onClick={session.interrupt}
                className="voice-rise mt-3 inline-flex h-7 items-center gap-2 rounded-full px-3 text-[12px] text-foreground/75 shadow-[0_0_0_0.5px_var(--border-strong)] hover:bg-white/[0.06] hover:text-foreground"
              >
                {t('assistant.voice.stage.stopReply')}
                <kbd className="font-mono text-[10.5px] text-muted-foreground">Esc</kbd>
              </button>
            )}
            {session.idleClosesAt && <IdleWarning closesAt={session.idleClosesAt} onKeep={session.keepCall} />}
            {session.question ? (
              <ConfirmCard
                question={session.question}
                voiceAnswers={voiceAnswers}
                onOpenConversation={() => onOpenConversation()}
              />
            ) : (
              <ActivityList items={session.activity.items} onOpenConversation={() => onOpenConversation()} />
            )}
          </div>
          <div className="flex items-center justify-center gap-[30px] pb-6 pt-4">
            <button
              type="button"
              aria-label={t('assistant.voice.stage.write')}
              title={t('assistant.voice.stage.write')}
              onClick={() => onOpenConversation(true)}
              className="grid size-11 place-items-center rounded-full bg-white/[0.06] text-foreground/75 transition-colors hover:bg-white/[0.1] hover:text-foreground"
            >
              <Keyboard aria-hidden="true" className="size-4" />
            </button>
            <MainButton session={session} />
            <EndButton session={session} onExit={onExit} />
          </div>
        </>
      )}
    </section>
  )
}

/** The voice, folded into a bar over the conversation: it keeps going, and a click brings it back. */
export function VoiceStrip({ session, onBack, onExit }: { session: VoiceSession; onBack(): void; onExit(): void }) {
  const { t } = useTranslation('ui')
  const phase = phaseOf(session)
  const over = callOver(session)
  return (
    <section
      aria-label={t('assistant.voice.stage.label')}
      data-voice-strip={over ? 'ended' : phase}
      className="hairline-b grid h-[60px] shrink-0 grid-cols-[104px_minmax(0,1fr)_auto] items-center gap-2 pl-2.5 pr-3"
    >
      <VoiceStaff
        mode={over ? 'off' : staffMode(session, phase)}
        levels={session.levels}
        compact
        className="h-10 w-[104px]"
      />
      <button
        type="button"
        onClick={onBack}
        title={t('assistant.voice.stage.backToVoice')}
        className="flex min-w-0 flex-col items-stretch gap-0.5 rounded-md px-1.5 py-1 text-left hover:bg-white/[0.04]"
      >
        <span
          className={cn(
            'text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground',
            !over && EYEBROW_TONE[phase]
          )}
        >
          {over ? t('assistant.voice.stage.ended.title') : t(`assistant.voice.stage.phase.${phase}`)}
        </span>
        {!over && <Caption caption={session.caption} phase={phase} size="line" />}
        <span className="sr-only">{t('assistant.voice.stage.backToVoice')}</span>
      </button>
      {!over && (
        <div className="flex items-center gap-2">
          <MainButton session={session} compact />
          <EndButton session={session} onExit={onExit} compact />
        </div>
      )}
    </section>
  )
}

/** The header's mark of the voice: the mode, and the call's time. */
export function VoiceCallChip({ session }: { session: VoiceSession }) {
  const { t } = useTranslation('ui')
  const elapsed = useElapsed(session.realtimeStartedAt)
  const live = session.mode === 'realtime' ? !!session.call : session.state !== 'idle'
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn(
          'size-[7px] shrink-0 rounded-full transition-colors',
          live && !session.muted ? 'bg-status-ready' : 'bg-muted-foreground'
        )}
      />
      <strong className="font-semibold text-foreground">
        {t(session.mode === 'realtime' ? 'assistant.voice.stage.chipRealtime' : 'assistant.voice.stage.chipVoice')}
      </strong>
      {elapsed && (
        <span className="font-mono tabular-nums" title={t('assistant.voice.realtimeTimer')}>
          · {elapsed}
        </span>
      )}
    </span>
  )
}
