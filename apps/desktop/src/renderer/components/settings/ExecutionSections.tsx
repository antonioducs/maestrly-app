import { useEffect, useState } from 'react'
import { FolderOpen, ShieldAlert } from 'lucide-react'
import type { ChatPermMode } from '../../../preload'
import { Button } from '@/components/ui/button'
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

/** Folder where chats create and clone projects; chosen with the native picker and validated in main. */
export function ProjectsDirectorySection({ t }: { t: TFn }) {
  const [directory, setDirectory] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api
      .getProjectsDirectory()
      .then((value) => {
        if (alive) setDirectory(value)
      })
      .catch(() => {})
    const off = window.api.onProjectsDirectoryChanged(setDirectory)
    return () => {
      alive = false
      off()
    }
  }, [])

  const choose = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.pickProjectsDirectory()
      setDirectory(result.path)
      if (!result.ok && result.error) setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('settings.projectsDirectory.heading')}</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.projectsDirectory.desc')}</p>
      </div>
      <div className="flex items-center gap-2">
        <div
          data-testid="projects-directory-value"
          title={directory ?? undefined}
          className={cn(
            'min-w-0 flex-1 truncate rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-[12px]',
            directory ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {directory ?? t('settings.projectsDirectory.empty')}
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]" disabled={busy} onClick={choose}>
          <FolderOpen className="size-3.5" />
          {t('settings.projectsDirectory.choose')}
        </Button>
        {directory && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-[12px]"
            disabled={busy}
            onClick={async () => {
              await window.api.clearProjectsDirectory()
              setDirectory(null)
            }}
          >
            {t('settings.projectsDirectory.clear')}
          </Button>
        )}
      </div>
      {error && <p className="break-words text-[11px] text-destructive">{error}</p>}
    </section>
  )
}
