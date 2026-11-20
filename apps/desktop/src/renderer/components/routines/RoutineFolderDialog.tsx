import { useTranslation } from 'react-i18next'
import type { HostView } from '../../../shared/hosts'
import { HostProvider } from '@/lib/hosts/host-context'
import { routineHostDisplay } from '@/lib/routines/host-routines'
import type { RemoteRoutineFolderTarget } from '@/lib/routines/use-routines'
import { FilesPanel } from '@/components/files/FilesPanel'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { RoutineHostBadge } from './RoutineOutcomeBadge'

export function RoutineFolderDialog({
  target,
  hosts,
  onClose,
}: {
  target: RemoteRoutineFolderTarget | null
  hosts: readonly HostView[]
  onClose: () => void
}) {
  const { t } = useTranslation('routines')
  const tr = (key: string, opts?: Record<string, unknown>): string => String(t(key as never, opts as never))
  const host = target ? hosts.find((h) => h.id === target.hostId) : undefined
  const hostInfo = target ? routineHostDisplay(host, target.hostId, tr) : null

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(78vh,640px)] w-[min(760px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0">
        {target && hostInfo && (
          <>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3 pr-10">
              <div className="min-w-0">
                <DialogTitle className="flex items-center gap-2 truncate text-[14px] font-semibold">
                  <span className="truncate">{t('host.folderDialogTitle', { title: target.title })}</span>
                  <RoutineHostBadge host={host} hostId={target.hostId} compact />
                </DialogTitle>
                <DialogDescription className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {t('host.folderDialogDesc', { host: hostInfo.fullLabel })}
                </DialogDescription>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <HostProvider hostId={target.hostId}>
                <FilesPanel initialPath={target.folder} />
              </HostProvider>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
