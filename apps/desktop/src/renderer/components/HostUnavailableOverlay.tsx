import { useTranslation } from 'react-i18next'
import { LoaderCircle, ServerOff } from 'lucide-react'
import type { HostView } from '../../shared/hosts'
import { Button } from '@/components/ui/button'
import { hostSectionStatus, type HostSectionStatus } from '@/lib/hosts/host-status'

const TITLE: Record<Exclude<HostSectionStatus, 'online'>, string> = {
  connecting: 'hostOverlay.connecting',
  reconnecting: 'hostOverlay.reconnecting',
  incompatible: 'hostOverlay.incompatible',
  stopped: 'hostOverlay.stopped',
  starting: 'hostOverlay.starting',
  failed: 'hostOverlay.failed',
  offline: 'hostOverlay.offline',
  'not-hosting': 'hostOverlay.notHosting',
  removed: 'hostOverlay.removed',
  disconnected: 'hostOverlay.disconnected',
  'identity-changed': 'hostOverlay.identityChanged',
}

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
  const name = host.label || t(host.peer ? 'sidebar.peerUnnamed' : 'sidebar.hostUnnamed')
  const waiting = status === 'connecting' || status === 'reconnecting' || status === 'starting'
  return (
    <div
      data-host-overlay={status}
      role="status"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-chat-canvas p-6 text-center"
    >
      {waiting ? (
        <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
      ) : (
        <ServerOff className="size-6 text-muted-foreground" />
      )}
      <p className="text-sm font-medium">{t(TITLE[status], { host: name })}</p>
      {status === 'reconnecting' && (
        <p className="max-w-sm text-xs text-muted-foreground">
          {t(host.peer ? 'hostOverlay.peerReconnectingDetail' : 'hostOverlay.reconnectingDetail', { host: name })}
        </p>
      )}
      {(status === 'reconnecting' || status === 'offline' || status === 'not-hosting') && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('sidebar.hostRetry')}
        </Button>
      )}
      {status === 'disconnected' && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('sidebar.peerReconnect')}
        </Button>
      )}
      {(status === 'removed' || status === 'identity-changed') && (
        <Button variant="secondary" size="sm" onClick={onManage}>
          {t('sidebar.peerManage')}
        </Button>
      )}
      {(status === 'stopped' || status === 'failed') && (
        <Button variant="secondary" size="sm" onClick={onStart}>
          {t('sidebar.hostStart')}
        </Button>
      )}
      {status === 'incompatible' && (
        <Button variant="secondary" size="sm" onClick={onManage}>
          {t(host.peer ? 'sidebar.peerUpdates' : 'sidebar.hostManage')}
        </Button>
      )}
    </div>
  )
}
