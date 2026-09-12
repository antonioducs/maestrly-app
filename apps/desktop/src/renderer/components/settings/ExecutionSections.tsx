import { ShieldAlert } from 'lucide-react'
import type { ChatPermMode } from '../../../preload'
import { cn } from '@/lib/utils'
import type { TFn } from './shared'

export function DefaultPermissionSection({
  t,
  mode,
  onChange,
}: {
  t: TFn
  mode: ChatPermMode
  onChange: (mode: ChatPermMode) => void
}) {
  const modes: ChatPermMode[] = ['ask', 'auto', 'full']
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('settings.permissions.heading')}</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.permissions.desc')}</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {modes.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onChange(item)}
            className={cn(
              'rounded-lg border px-3 py-2 text-left text-xs transition-colors',
              mode === item
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-white/[0.04]'
            )}
          >
            <ShieldAlert className="mb-1 size-4" />
            {t(`settings.permissions.${item}`)}
          </button>
        ))}
      </div>
    </section>
  )
}
