import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Hand, ShieldAlert, TerminalSquare, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatPermMode } from '../../../shared/chat'

const MODES: { id: ChatPermMode; labelKey: string; descKey: string; icon: React.ReactNode; danger?: boolean }[] = [
  { id: 'ask', labelKey: 'perm.askLabel', descKey: 'perm.askDesc', icon: <Hand className="h-3.5 w-3.5" /> },
  {
    id: 'auto',
    labelKey: 'perm.autoLabel',
    descKey: 'perm.autoDesc',
    icon: <TerminalSquare className="h-3.5 w-3.5" />,
  },
  {
    id: 'full',
    labelKey: 'perm.fullLabel',
    descKey: 'perm.fullDesc',
    icon: <ShieldAlert className="h-3.5 w-3.5" />,
    danger: true,
  },
]

export function ChatPermModePicker({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation('chat')
  const [mode, setMode] = useState<ChatPermMode>('ask')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.chatGetPermMode(conversationId).then(setMode)
  }, [conversationId])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const current = MODES.find((m) => m.id === mode) ?? MODES[0]
  const choose = (id: ChatPermMode) => {
    setMode(id)
    setOpen(false)
    window.api.chatSetPermMode(conversationId, id)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] hover:bg-white/[0.05]',
          current.danger ? 'text-amber-400' : 'text-muted-foreground hover:text-foreground'
        )}
        title={t('perm.buttonTitle')}
      >
        {current.icon}
        <span className="max-w-[140px] truncate">{t(current.labelKey)}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-80 overflow-hidden rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => choose(m.id)}
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-white/[0.05]"
            >
              <span className={cn('mt-0.5 shrink-0', m.danger ? 'text-amber-400' : 'text-muted-foreground')}>
                {m.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[13px]', m.danger ? 'text-amber-300' : 'text-foreground')}>
                  {t(m.labelKey)}
                </span>
                <span className="block text-[11px] text-muted-foreground">{t(m.descKey)}</span>
              </span>
              <Check className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', mode === m.id ? 'opacity-100' : 'opacity-0')} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
