import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { hostApi } from '@/lib/hosts/host-context'
import { LOCAL_HOST_ID } from '../../../shared/host-key'
import type { InstalledPluginDto } from '../../../shared/plugins'
import { CompatibilityBadge } from './CompatibilityBadge'
import type { PluginsSource } from './plugins-source'
import { errorText, shortCommit } from './plugin-ui'

/**
 * Brings this computer's plugins to a bot environment: the environment downloads each one from its source at the same
 * commit, checks it against the approvals given here, and stores the values entered here. Lists only what this
 * computer has; nothing secret reaches this window.
 */
export function BringPluginsDialog({
  source,
  installedThere,
  onClose,
  onBrought,
}: {
  source: PluginsSource & { bring: NonNullable<PluginsSource['bring']> }
  /** Keys of the plugins the environment already has. */
  installedThere: ReadonlySet<string>
  onClose: () => void
  onBrought: () => void
}) {
  const { t } = useTranslation('plugins')
  const [local, setLocal] = useState<InstalledPluginDto[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [brought, setBrought] = useState<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    void hostApi(LOCAL_HOST_ID)
      .pluginsState()
      .then((state) => {
        if (alive) setLocal(state.installed)
      })
      .catch(() => {
        if (alive) setLocal([])
      })
    return () => {
      alive = false
    }
  }, [])

  const bring = async (plugin: InstalledPluginDto) => {
    if (busy) return
    setBusy(plugin.key)
    setErrors(({ [plugin.key]: _cleared, ...rest }) => rest)
    try {
      const result = await source.bring(plugin.key)
      if (result.ok) {
        setBrought((current) => new Set([...current, plugin.key]))
        source.notifyChanged()
        onBrought()
      } else
        setErrors((current) => ({
          ...current,
          [plugin.key]: result.error === 'consent-required' ? t('bring.changed') : errorText(t, result.error),
        }))
    } catch (cause) {
      setErrors((current) => ({ ...current, [plugin.key]: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto" data-testid="bring-plugins">
        <DialogHeader>
          <DialogTitle>{t('bring.title')}</DialogTitle>
          <DialogDescription>{t('bring.description')}</DialogDescription>
        </DialogHeader>
        {!local ? (
          <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('browse.loading')}
          </p>
        ) : local.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t('bring.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {local.map((plugin) => {
              const there = installedThere.has(plugin.key) || brought.has(plugin.key)
              return (
                <li
                  key={plugin.key}
                  data-plugin={plugin.name}
                  className="flex flex-col gap-1 rounded-lg border border-border bg-white/[0.02] px-2.5 py-2"
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] text-foreground">{plugin.displayName}</span>
                        <CompatibilityBadge compatibility={plugin.compatibility} />
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {plugin.version ? `${t('installed.version', { version: plugin.version })} · ` : ''}
                        {t('installed.commit', { commit: shortCommit(plugin.commit) })}
                      </div>
                    </div>
                    {there ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-emerald-300/90">
                        <Check className="h-3.5 w-3.5" /> {t('bring.installedThere')}
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        aria-label={`${t('bring.action')}: ${plugin.displayName}`}
                        onClick={() => void bring(plugin)}
                      >
                        {busy === plugin.key && <Loader2 className="animate-spin" />}
                        {busy === plugin.key ? t('bring.bringing') : t('bring.action')}
                      </Button>
                    )}
                  </div>
                  {errors[plugin.key] && (
                    <p role="alert" className="text-[11px] text-destructive">
                      {errors[plugin.key]}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy !== null}>
            {t('bring.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
