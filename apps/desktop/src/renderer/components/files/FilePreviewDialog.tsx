import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useHostApi } from '@/lib/hosts/host-context'
import { type HostFsEntry, type HostFsPreview, hostFsErrorCode } from '../../../shared/host-fs'
import { formatBytes } from '../chat/runtime-asset-presentation'

const PREVIEW_BYTES = 64 * 1024

/** The first lines of a host's file, read there: nothing is downloaded. */
export function FilePreviewDialog({ entry, onClose }: { entry: HostFsEntry; onClose: () => void }) {
  const { t } = useTranslation('ui')
  const api = useHostApi()
  const [preview, setPreview] = useState<HostFsPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setPreview(null)
    setError(null)
    api.hostFsPreview(entry.path).then(
      (value) => alive && setPreview(value),
      (cause) => alive && setError(t(`hostFolder.errors.${hostFsErrorCode(cause) ?? 'unknown'}`))
    )
    return () => {
      alive = false
    }
  }, [api, entry.path, t])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{entry.name}</DialogTitle>
          <DialogDescription className="truncate">{entry.path}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : !preview ? (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        ) : preview.binary ? (
          <p className="text-xs text-muted-foreground">{t('files.previewBinary')}</p>
        ) : (
          <>
            <pre
              data-testid="file-preview"
              className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-white/[0.03] p-3 text-xs"
            >
              {preview.text}
            </pre>
            {preview.truncated && (
              <p className="text-xs text-muted-foreground">
                {t('files.previewTruncated', { size: formatBytes(PREVIEW_BYTES) })}
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
