import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Bot, Palette, ClipboardList, MessageCircle, Check, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatMode } from '../../../shared/chat'
import type { StandardToMaestroError, StandardToMaestroResult } from '../../../shared/conversation-experience'

export const CHAT_MODES: { id: ChatMode; labelKey: string; descKey: string; icon: React.ReactNode }[] = [
  { id: 'agent', labelKey: 'mode.agentLabel', descKey: 'mode.agentDesc', icon: <Bot className="h-3.5 w-3.5" /> },
  { id: 'design', labelKey: 'mode.designLabel', descKey: 'mode.designDesc', icon: <Palette className="h-3.5 w-3.5" /> },
  { id: 'plan', labelKey: 'mode.planLabel', descKey: 'mode.planDesc', icon: <ClipboardList className="h-3.5 w-3.5" /> },
  { id: 'ask', labelKey: 'mode.askLabel', descKey: 'mode.askDesc', icon: <MessageCircle className="h-3.5 w-3.5" /> },
]

export function ChatModePicker({
  conversationId,
  mode,
  onChange,
  onUseMaestro,
  maestroDisabled = false,
  modelId,
}: {
  conversationId: string
  mode: ChatMode
  onChange: (m: ChatMode) => Promise<{ ok: boolean; error?: string }>
  onUseMaestro?: () => Promise<StandardToMaestroResult>
  maestroDisabled?: boolean
  modelId?: string | null
}) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const conversationIdRef = useRef(conversationId)
  const modeRequestRef = useRef(0)
  conversationIdRef.current = conversationId

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      modeRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    modeRequestRef.current += 1
    setTransitioning(false)
    setTransitionError(null)
    setOpen(false)
  }, [conversationId])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const current = CHAT_MODES.find((m) => m.id === mode) ?? CHAT_MODES[0]
  const choose = async (id: ChatMode) => {
    if (transitioning) return
    if (id === mode) {
      setOpen(false)
      return
    }
    const targetConversationId = conversationId
    const request = ++modeRequestRef.current
    setTransitionError(null)
    setTransitioning(true)
    try {
      const result = await onChange(id)
      if (
        !mountedRef.current ||
        conversationIdRef.current !== targetConversationId ||
        modeRequestRef.current !== request
      )
        return
      if (!result.ok) return
      setOpen(false)
    } catch {
      // ChatView owns persistence errors so every trigger, including Shift+Tab, has one consistent alert.
    } finally {
      if (
        mountedRef.current &&
        conversationIdRef.current === targetConversationId &&
        modeRequestRef.current === request
      ) {
        setTransitioning(false)
      }
    }
  }

  const maestroError = (code: StandardToMaestroError): string => {
    const keys: Record<StandardToMaestroError, string> = {
      'invalid-conversation': 'mode.maestroErrors.invalidConversation',
      'not-standard': 'mode.maestroErrors.notStandard',
      'conversation-busy': 'mode.maestroErrors.busy',
      'conversation-reserved': 'mode.maestroErrors.reserved',
      'conversation-migrating': 'mode.maestroErrors.migrating',
    }
    return t(keys[code])
  }

  const chooseMaestro = async () => {
    if (!onUseMaestro || maestroDisabled || transitioning) return
    setTransitionError(null)
    setTransitioning(true)
    try {
      const payload = await window.api.chatMaestroGetConversation(conversationId)
      const strategy = t(`maestro.strategies.${payload.config.strategy}`)
      const model = modelId || t('mode.selectedModel')
      if (!window.confirm(t('mode.confirmMaestro', { model, strategy }))) return
      const result = await onUseMaestro()
      if (!result.ok) {
        setTransitionError(maestroError(result.error))
        return
      }
      setOpen(false)
    } catch (reason) {
      setTransitionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setTransitioning(false)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        aria-expanded={open}
        type="button"
        onClick={() => {
          setTransitionError(null)
          setOpen((o) => !o)
        }}
        className={cn(
          'flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] hover:bg-white/[0.05]',
          mode === 'design'
            ? 'bg-amber-400/[0.09] text-amber-300 ring-1 ring-inset ring-orange-400/20 hover:bg-amber-400/[0.14] hover:text-amber-200'
            : mode === 'agent'
              ? 'text-muted-foreground hover:text-foreground'
              : 'text-indigo-300'
        )}
        title={t('mode.buttonTitle')}
      >
        {current.icon}
        <span className="max-w-[110px] truncate">{t(current.labelKey)}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-80 overflow-hidden rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl">
          <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            {t('mode.heading')}
          </div>
          <p className="px-2.5 pb-1 text-[10px] leading-relaxed text-muted-foreground/70">{t('mode.shortcutHelp')}</p>
          {CHAT_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => void choose(m.id)}
              disabled={transitioning}
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-white/[0.05] disabled:cursor-wait disabled:opacity-60"
            >
              <span className="mt-0.5 shrink-0 text-muted-foreground">{m.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-foreground">{t(m.labelKey)}</span>
                <span className="block text-[11px] text-muted-foreground">{t(m.descKey)}</span>
              </span>
              <Check className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', mode === m.id ? 'opacity-100' : 'opacity-0')} />
            </button>
          ))}
          {transitionError && (
            <p
              role="alert"
              className="mx-2 mb-1 rounded border border-red-500/20 bg-red-500/[0.08] p-2 text-[11px] text-red-300"
            >
              {transitionError}
            </p>
          )}
          {onUseMaestro && (
            <>
              <div className="mx-2 my-1 h-px bg-white/[0.08]" />
              <button
                type="button"
                onClick={() => void chooseMaestro()}
                disabled={maestroDisabled || transitioning}
                className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-amber-400/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="mt-0.5 shrink-0 text-amber-300">
                  {transitioning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-amber-100">{t('mode.useMaestro')}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {maestroDisabled ? t('mode.maestroBusyDesc') : t('mode.maestroDesc')}
                  </span>
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
