import { useTranslation } from 'react-i18next'
import { LoaderCircle, ServerOff } from 'lucide-react'
import type { HostView } from '../../shared/hosts'
import { Button } from '@/components/ui/button'
import { hostSectionStatus } from '@/lib/hosts/host-status'

/**
 * Covers a conversation of a remote host while this computer cannot reach that host. The conversation stays as it was
 * underneath; once the host answers again it is loaded again.
 */
export function HostUnavailableOverlay({
  host,
  onRetry,
  onStart,
  onManage,
}: {
  host: HostView
  onRetry: () => void
  onStart: () => void
  onManage: () => void
}) {
  const { t } = useTranslation('ui')
  const status = hostSectionStatus(host)
  if (status === 'online') return null
  const name = host.label || t('sidebar.hostUnnamed')
  const waiting = status === 'connecting' || status === 'reconnecting' || status === 'starting'
  return (
    <div
      data-host-overlay={status}
      role="status"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/80 p-6 text-center backdrop-blur-sm"
    >
      {waiting ? (
        <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
      ) : (
        <ServerOff className="size-6 text-muted-foreground" />
      )}
      <p className="text-sm font-medium">{t(`hostOverlay.${status}`, { host: name })}</p>
      {status === 'reconnecting' && (
        <p className="max-w-sm text-xs text-muted-foreground">{t('hostOverlay.reconnectingDetail')}</p>
      )}
      {(status === 'reconnecting' || status === 'offline') && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('sidebar.hostRetry')}
        </Button>
      )}
      {(status === 'stopped' || status === 'failed') && (
        <Button variant="secondary" size="sm" onClick={onStart}>
          {t('sidebar.hostStart')}
        </Button>
      )}
      {status === 'incompatible' && (
        <Button variant="secondary" size="sm" onClick={onManage}>
          {t('sidebar.hostManage')}
        </Button>
      )}
    </div>
  )
}
