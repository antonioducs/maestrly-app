import { useTranslation } from 'react-i18next'
import { GitBranch, Loader2, RotateCcw, ShieldAlert } from 'lucide-react'
import type { MoveRecovery } from '../../../preload'
import type { HostId } from '../../../shared/host-key'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Props {
  recoveries: MoveRecovery[]
  error: string | null
  resolving: { operationId: string; action: 'continue' | 'rollback' } | null
  hostLabel: (hostId: HostId) => string
  onResolve: (recovery: MoveRecovery, action: 'continue' | 'rollback') => void
  onRetry: () => void
}

/** Moves that stopped halfway hold their conversation on both hosts until the person continues or undoes them. */
export function ConversationMoveRecoveryGate({ recoveries, error, resolving, hostLabel, onResolve, onRetry }: Props) {
  const { t } = useTranslation('ui')
  if (recoveries.length === 0) return null
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="flex max-h-[85vh] max-w-2xl flex-col gap-4 overflow-y-auto"
        showClose={false}
        aria-busy={!!resolving}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-amber-300" />
            {t('conversationMove.recovery.title')}
          </DialogTitle>
          <DialogDescription>{t('conversationMove.recovery.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {recoveries.map((recovery) => {
            const busy = resolving?.operationId === recovery.operationId
            return (
              <section key={recovery.operationId} className="rounded-lg border border-border p-4">
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <span className="text-muted-foreground">{t('conversationMove.recovery.conversation')}</span>
                  <span className="truncate">{recovery.conversationName}</span>
                  <span className="text-muted-foreground">{t('conversationMove.recovery.route')}</span>
                  <span>
                    {hostLabel(recovery.sourceHostId)} → {hostLabel(recovery.targetHostId)}
                  </span>
                  <span className="text-muted-foreground">{t('conversationMove.recovery.phase')}</span>
                  <span>{t(`conversationMove.phase.${recovery.phase}`)}</span>
                </div>
                {(recovery.errorCode || recovery.message) && (
                  <p className="mt-3 text-xs text-amber-100">
                    {t(`conversationMove.error.${recovery.errorCode ?? 'unknown'}`, {
                      defaultValue: recovery.message ?? '',
                    })}
                  </p>
                )}
                {!recovery.canRollback && (
                  <p className="mt-1 text-xs text-muted-foreground">{t('conversationMove.onlyContinue')}</p>
                )}
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={!recovery.canRollback || !!resolving}
                    onClick={() => onResolve(recovery, 'rollback')}
                  >
                    {busy && resolving?.action === 'rollback' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                    {t('conversationMove.actions.rollback')}
                  </Button>
                  <Button
                    disabled={!recovery.canContinue || !!resolving}
                    onClick={() => onResolve(recovery, 'continue')}
                  >
                    {busy && resolving?.action === 'continue' ? <Loader2 className="animate-spin" /> : <GitBranch />}
                    {t('conversationMove.actions.continue')}
                  </Button>
                </div>
              </section>
            )
          })}
        </div>
        {error && (
          <div className="flex items-center justify-between gap-3" role="alert">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" onClick={onRetry} disabled={!!resolving}>
              {t('common.retry')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
