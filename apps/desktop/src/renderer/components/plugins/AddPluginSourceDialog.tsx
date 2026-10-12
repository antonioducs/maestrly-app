import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { PluginsSource } from './plugins-source'
import { errorText, inputCls } from './plugin-ui'

/** Adds a Git marketplace source: repository, optional ref and optional sparse folders. Adding only lists plugins. */
export function AddPluginSourceDialog({
  source,
  gitAvailable,
  onClose,
  onAdded,
}: {
  source: PluginsSource
  gitAvailable: boolean
  onClose: () => void
  onAdded: (marketplaceId: string) => void
}) {
  const { t } = useTranslation('plugins')
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [sparse, setSparse] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!url.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await source.pluginsMarketplaceAdd({
        url: url.trim(),
        ref: ref.trim() || null,
        sparsePaths: sparse
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      })
      if (!result.ok) {
        setError(t(`sources.error.${result.error}`, { defaultValue: errorText(t, result.error) }))
        return
      }
      source.notifyChanged()
      onAdded(result.value.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-w-lg"
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onPointerDownOutside={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('sources.add')}</DialogTitle>
          <DialogDescription>{t('sources.onlyLists')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="plugin-source-url">{t('sources.url')}</Label>
            <input
              id="plugin-source-url"
              className={inputCls}
              value={url}
              autoFocus
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t('sources.urlPlaceholder')}
              disabled={busy}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="plugin-source-ref">{t('sources.ref')}</Label>
            <input
              id="plugin-source-ref"
              className={inputCls}
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="plugin-source-sparse">{t('sources.sparse')}</Label>
            <textarea
              id="plugin-source-sparse"
              className={`${inputCls} min-h-16 font-mono`}
              value={sparse}
              onChange={(event) => setSparse(event.target.value)}
              disabled={busy}
            />
          </div>
          {!gitAvailable && <p className="text-[12px] text-amber-300">{t('git.unavailable')}</p>}
          {error && (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              {t('installed.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !url.trim() || !gitAvailable}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t('sources.adding') : t('sources.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
