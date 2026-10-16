import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fixedPanelPlacement } from '@/lib/fixed-panel-position'
import { useChatDocument, useChatOwnerWindow } from '@/lib/chat-window-context'
import type { ChatProviderInfo } from '../../../../shared/chat'
import {
  effortShortLabel,
  modelSelectionKey,
  providerTone,
  useHighlightedModel,
  type ModelSelection,
} from './model-selection'

const PANEL_WIDTH = 360

/** Compact summary of a model selection: provider tone, model, provider, effort and Fast. */
export function ModelChipContent({
  value,
  providers,
  placeholder,
}: {
  value: ModelSelection | null
  providers: ChatProviderInfo[]
  placeholder: string
}) {
  const { t } = useTranslation('chat')
  if (!value) {
    return (
      <>
        <span className="size-2 shrink-0 rounded-full border border-muted-foreground/60" />
        <span className="truncate text-muted-foreground">{placeholder}</span>
      </>
    )
  }
  const provider = providers.find((item) => item.id === value.providerId)
  // The colour tells providers apart; the name is needed only when two accounts share one.
  const ambiguous = !provider || providers.some((item) => item !== provider && item.kind === provider.kind)
  return (
    <>
      <span className={cn('size-2 shrink-0 rounded-full', providerTone(provider))} />
      <span className="min-w-0 shrink truncate font-medium text-foreground">{value.modelId}</span>
      {ambiguous && (
        <span className="min-w-0 shrink-[2] truncate text-[11px] text-muted-foreground">
          {provider?.name ?? value.providerId}
        </span>
      )}
      {value.effort && value.effort !== 'off' && (
        <span className="shrink-0 rounded bg-white/[0.07] px-1.5 py-px text-[10.5px] text-muted-foreground">
          {effortShortLabel(value.effort, t)}
        </span>
      )}
      {value.fastMode === true && (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/10 px-1.5 py-px text-[10.5px] text-amber-300">
          <Zap className="size-2.5 fill-current" />
          {t('fastMode.label')}
        </span>
      )}
    </>
  )
}

/**
 * A model chip that opens its editor in a panel next to it. The panel is a descendant of the chip's wrapper, so
 * the search selects inside it count as inside for outside clicks, and their own Escape closes them first.
 */
export function ModelPicker({
  value,
  providers,
  label,
  placeholder,
  size = 'md',
  dimmed = false,
  readOnly = false,
  open: controlledOpen,
  onOpenChange,
  className,
  children,
}: {
  value: ModelSelection | null
  providers: ChatProviderInfo[]
  /** Names the chip and its panel, e.g. "Default model". */
  label: string
  placeholder: string
  size?: 'md' | 'lg'
  /** The task using this model is off: the chip stays editable but recedes. */
  dimmed?: boolean
  readOnly?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  children: (close: () => void) => ReactNode
}) {
  const ownerWindow = useChatOwnerWindow()
  const ownerDocument = useChatDocument()
  const highlighted = useHighlightedModel()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const [panelStyle, setPanelStyle] = useState<CSSProperties>()
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [controlledOpen, onOpenChange]
  )
  const close = useCallback(() => setOpen(false), [setOpen])

  const position = useCallback(() => {
    const wrap = wrapRef.current
    const trigger = triggerRef.current
    if (!wrap || !trigger) return
    setPanelStyle(
      fixedPanelPlacement(wrap, {
        anchor: trigger,
        width: Math.min(PANEL_WIDTH, ownerWindow.innerWidth - 16),
        estimatedHeight: Math.max(panelRef.current?.offsetHeight ?? 0, 320),
        align: 'end',
      }).style
    )
  }, [ownerWindow])

  useLayoutEffect(() => {
    if (open) position()
  }, [open, position])

  useEffect(() => {
    if (!open) return
    const frame = ownerWindow.requestAnimationFrame(() => {
      position()
      panelRef.current?.querySelector<HTMLElement>('button:not([disabled]), input')?.focus()
    })
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    // Before the settings dialog, which closes on the same Escape; an open select inside closes first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (panelRef.current?.querySelector('[data-search-select] [aria-expanded="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    ownerDocument.addEventListener('mousedown', onDown)
    ownerWindow.addEventListener('keydown', onKey, true)
    ownerWindow.addEventListener('resize', position)
    ownerWindow.addEventListener('scroll', position, true)
    return () => {
      ownerWindow.cancelAnimationFrame(frame)
      ownerDocument.removeEventListener('mousedown', onDown)
      ownerWindow.removeEventListener('keydown', onKey, true)
      ownerWindow.removeEventListener('resize', position)
      ownerWindow.removeEventListener('scroll', position, true)
    }
  }, [open, ownerDocument, ownerWindow, position, setOpen])

  const isHighlighted = value != null && highlighted === modelSelectionKey(value)
  return (
    <div ref={wrapRef} className={cn('relative min-w-0 max-w-full', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          value
            ? `${value.modelId} · ${providers.find((item) => item.id === value.providerId)?.name ?? value.providerId}`
            : placeholder
        }
        disabled={readOnly}
        data-model-key={value ? modelSelectionKey(value) : undefined}
        onClick={() => setOpen(!open)}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md border bg-white/[0.03] text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          size === 'lg' ? 'h-9 px-3 text-[13px]' : 'h-8 px-2.5 text-[12px]',
          open || isHighlighted ? 'border-indigo-400/60' : 'border-border hover:border-border-strong',
          isHighlighted && 'ring-2 ring-indigo-400/30',
          !readOnly && 'hover:bg-white/[0.06]',
          readOnly && 'cursor-default',
          dimmed && !isHighlighted && 'opacity-55'
        )}
      >
        <ModelChipContent value={value} providers={providers} placeholder={placeholder} />
        {!readOnly && <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={label}
          style={panelStyle}
          className="z-[60] flex max-h-[min(560px,calc(100vh-24px))] flex-col gap-3 overflow-y-auto rounded-lg border border-border-strong bg-popover p-3 text-popover-foreground shadow-2xl"
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}
