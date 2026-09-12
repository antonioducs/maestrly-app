import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'
import { cn } from '@/lib/utils'

export function FastModeChip({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const { t } = useTranslation('chat')
  return (
    <button
      type="button"
      aria-pressed={enabled}
      onClick={onToggle}
      title={t('fastMode.tooltip')}
      className={cn(
        'flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] transition-colors hover:bg-white/[0.05]',
        enabled ? 'bg-amber-500/10 text-amber-300 hover:bg-amber-500/15' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <Zap className={cn('h-3.5 w-3.5', enabled && 'fill-current')} />
      <span>{t('fastMode.label')}</span>
    </button>
  )
}

export function ChatFastModeToggle({ conversationId }: { conversationId: string }) {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let alive = true

    setEnabled(false)
    void window.api.chatGetFastMode(conversationId).then((value) => {
      if (alive) setEnabled(value)
    })
    return () => {
      alive = false
    }
  }, [conversationId])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    void window.api.chatSetFastMode(conversationId, next)
  }

  return <FastModeChip enabled={enabled} onToggle={toggle} />
}
