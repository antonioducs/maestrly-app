import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Brain, Check, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isMaestrlyUltraEffort, MAESTRLY_ULTRA_EFFORT, reasoningPickerUltraState } from '../../../shared/chat'
import type { ChatReasoningEffort } from '../../../shared/chat'

export function ChatReasoningPicker({
  value,
  efforts,
  nativeUltraMode = false,
  allowUltra = true,
  avoidOverflow = false,
  onChange,
}: {
  value: ChatReasoningEffort
  efforts: string[]
  nativeUltraMode?: boolean

  allowUltra?: boolean

  avoidOverflow?: boolean
  onChange: (effort: ChatReasoningEffort) => void
}) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<CSSProperties>()
  const ref = useRef<HTMLDivElement>(null)
  const positionPanel = useCallback(() => {
    if (!avoidOverflow) return
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(224, window.innerWidth - 16)
    const estimatedHeight = Math.min(288, window.innerHeight * 0.5)
    const opensUp = rect.bottom + estimatedHeight > window.innerHeight && rect.top > estimatedHeight
    setPanelStyle({
      position: 'fixed',
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: opensUp ? undefined : rect.bottom + 4,
      bottom: opensUp ? window.innerHeight - rect.top + 4 : undefined,
      width,
    })
  }, [avoidOverflow])

  const {
    regularEfforts: visibleEfforts,
    ultraValue,
    unifiedNativeUltra: hasUnifiedNativeUltra,
  } = reasoningPickerUltraState(efforts, nativeUltraMode)
  const isMaestrlyUltra = isMaestrlyUltraEffort(value, efforts)
  const isUltra = isMaestrlyUltra || (hasUnifiedNativeUltra && value === 'ultra')

  useEffect(() => {
    if (!allowUltra) {
      if (value !== 'off' && (isUltra || (efforts.length > 0 && !efforts.includes(value)))) onChange('off')
      return
    }
    if (value === 'ultra' && isMaestrlyUltra) {
      onChange(MAESTRLY_ULTRA_EFFORT)
    } else if (value !== 'off' && value !== MAESTRLY_ULTRA_EFFORT && efforts.length > 0 && !efforts.includes(value)) {
      onChange('off')
    }
  }, [allowUltra, efforts, value, isUltra, isMaestrlyUltra, onChange])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (!open || !avoidOverflow) return
    positionPanel()
    const reposition = () => positionPanel()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [avoidOverflow, open, positionPanel])

  const choose = (id: ChatReasoningEffort) => {
    setOpen(false)
    onChange(id)
  }

  const ultraLabel = hasUnifiedNativeUltra ? t('reasoning.ultra') : t('reasoning.maestrlyUltra')
  const ultraDescription = hasUnifiedNativeUltra ? t('reasoning.nativeUltraDesc') : t('reasoning.ultraDesc')
  const label = value === 'off' ? '' : isUltra ? ultraLabel : value

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          if (open) setOpen(false)
          else {
            positionPanel()
            setOpen(true)
          }
        }}
        className={cn(
          'flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] hover:bg-white/[0.05]',
          isUltra
            ? 'bg-fuchsia-500/10 text-fuchsia-300 hover:bg-fuchsia-500/15'
            : value === 'off'
              ? 'text-muted-foreground hover:text-foreground'
              : 'text-violet-300'
        )}
        title={isUltra ? `${ultraDescription} · ${t('reasoning.quickCycleHint')}` : t('reasoning.buttonTitle')}
        aria-keyshortcuts="Control+Tab"
      >
        {isUltra ? <Sparkles className="h-3.5 w-3.5" /> : <Brain className="h-3.5 w-3.5" />}
        {label && <span className="max-w-[80px] truncate">{label}</span>}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          style={avoidOverflow ? panelStyle : undefined}
          className={cn(
            'z-[80] max-h-72 overflow-auto rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl',
            avoidOverflow ? 'fixed' : 'absolute bottom-full left-0 mb-1 w-56'
          )}
        >
          <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            {t('reasoning.heading')}
          </div>

          {(['off', ...visibleEfforts] as ChatReasoningEffort[]).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => choose(id)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-white/[0.05]"
            >
              <span
                className={cn('min-w-0 flex-1 text-[13px]', id === 'off' ? 'text-muted-foreground' : 'text-foreground')}
              >
                {id === 'off' ? t('reasoning.default') : id}
              </span>
              <Check className={cn('h-3.5 w-3.5 shrink-0', value === id ? 'opacity-100' : 'opacity-0')} />
            </button>
          ))}

          {allowUltra && (
            <>
              <div className="mx-1 my-1 border-t border-white/[0.08]" />
              <button
                type="button"
                onClick={() => choose(ultraValue)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left',
                  'bg-gradient-to-r from-fuchsia-500/10 to-violet-500/10 hover:from-fuchsia-500/20 hover:to-violet-500/20'
                )}
              >
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fuchsia-300" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fuchsia-200">{ultraLabel}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">{ultraDescription}</span>
                </span>
                <Check
                  className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-fuchsia-300', isUltra ? 'opacity-100' : 'opacity-0')}
                />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
