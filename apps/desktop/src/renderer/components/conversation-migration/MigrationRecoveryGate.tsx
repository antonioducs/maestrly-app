import { useTranslation } from 'react-i18next'
import { GitBranch, Loader2, RotateCcw, ShieldAlert } from 'lucide-react'
import type { MigrationRecovery } from '../../../preload'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Props {
  checking: boolean
  recoveries: MigrationRecovery[]
  error: string | null
  resolving: { operationId: string; action: 'continue' | 'rollback' } | null
  onResolve: (recovery: MigrationRecovery, action: 'continue' | 'rollback') => void
  onRetry: () => void
}

export function MigrationRecoveryGate({ checking, recoveries, error, resolving, onResolve, onRetry }: Props) {
  const { t } = useTranslation('ui')
  if (!checking && recoveries.length === 0 && !error) return null

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="flex max-h-[85vh] max-w-2xl flex-col gap-4 overflow-y-auto"
        showClose={false}
        aria-busy={checking || !!resolving}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-amber-300" />
            {t('conversationMigration.recoveryTitle')}
          </DialogTitle>
          <DialogDescription>{t('conversationMigration.recoveryDescription')}</DialogDescription>
        </DialogHeader>

        {checking ? (
          <div className="flex items-center gap-2 py-6 text-sm" role="status" aria-live="polite">
            <Loader2 className="size-4 animate-spin" /> {t('conversationMigration.recoveryChecking')}
          </div>
        ) : (
          <div className="space-y-3">
            {recoveries.map((recovery) => {
              const busy = resolving?.operationId === recovery.operationId
              return (
                <section key={recovery.operationId} className="rounded-lg border border-border p-4">
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <span className="text-muted-foreground">{t('conversationMigration.recoveryPhase')}</span>
                    <span>{t(`conversationMigration.phase.${recovery.phase}`)}</span>
                    <span className="text-muted-foreground">{t('conversationMigration.source')}</span>
                    <span className="truncate font-mono" title={recovery.sourceCwd}>
                      {recovery.sourceCwd}
                    </span>
                    <span className="text-muted-foreground">{t('conversationMigration.destination')}</span>
                    <span className="truncate font-mono" title={recovery.destinationCwd}>
                      {recovery.destinationCwd}
                    </span>
                    {recovery.stashOid && (
                      <>
                        <span className="text-muted-foreground">{t('conversationMigration.stash')}</span>
                        <span className="font-mono">{recovery.stashOid}</span>
                      </>
                    )}
                  </div>
                  {recovery.message && <p className="mt-3 text-xs text-amber-100">{recovery.message}</p>}
                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <Button
                      variant="outline"
                      disabled={!recovery.canRollback || !!resolving}
                      onClick={() => onResolve(recovery, 'rollback')}
                    >
                      {busy && resolving?.action === 'rollback' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                      {t('conversationMigration.rollback')}
                    </Button>
                    <Button
                      disabled={!recovery.canContinue || !!resolving}
                      onClick={() => onResolve(recovery, 'continue')}
                    >
                      {busy && resolving?.action === 'continue' ? <Loader2 className="animate-spin" /> : <GitBranch />}
                      {t('conversationMigration.continue')}
                    </Button>
                  </div>
                </section>
              )
            })}
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-3" role="alert">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" onClick={onRetry} disabled={checking || !!resolving}>
              {t('common.retry')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
