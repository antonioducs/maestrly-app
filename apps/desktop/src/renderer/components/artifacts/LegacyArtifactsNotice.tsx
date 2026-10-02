import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, ChevronRight, Laptop, Trash2 } from 'lucide-react'
import type { ArtifactServerStatus, LegacyArtifactView, LegacyMoveState } from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { moveDialogModel } from './artifacts-view'
import { LegacyArtifactRow, MoveArtifactsDialog, SharedTag } from './MoveArtifactsDialog'

/**
 * Artifacts earlier versions published on this computer. Artifacts live only on the bot server now, so these no
 * longer open: the owner moves them there or deletes them. Shows nothing when there are none.
 */
export function LegacyArtifactsNotice({
  items,
  server,
  move,
  onRaiseLimit,
  onOpenCenter,
}: {
  items: LegacyArtifactView[]
  server: ArtifactServerStatus | null
  move: LegacyMoveState
  onRaiseLimit: () => void
  onOpenCenter?: () => void
}) {
  const { t } = useTranslation('ui')
  const [moving, setMoving] = useState(false)
  const [deleting, setDeleting] = useState<'ask' | 'busy' | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const running = move.phase === 'running'
  // The dialog follows a move that runs or failed, even after the page was left and opened again.
  const dialogOpen = moving || running
  if (!items.length && !dialogOpen) return null

  const count = items.length
  const model = moveDialogModel(items, server)
  const total = items.reduce((sum, item) => sum + item.storageBytes, 0)
  const remove = async () => {
    setDeleting('busy')
    setDeleteError(null)
    try {
      await window.api.artifacts.legacyDelete()
      setDeleting(null)
    } catch (reason) {
      setDeleting('ask')
      setDeleteError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <>
      {count > 0 && (
        <section
          aria-labelledby="legacy-artifacts-title"
          data-testid="artifacts-legacy"
          className="flex gap-3 rounded-xl border border-artifact-warn/30 bg-artifact-warn/[0.07] px-4 py-3.5"
        >
          <Laptop className="mt-0.5 size-4 shrink-0 text-artifact-warn" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <div>
              <h3 id="legacy-artifacts-title" className="text-[13.5px] font-semibold text-foreground">
                {t('artifacts.legacy.title', { count })}
              </h3>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-foreground/80">
                {t('artifacts.legacy.text', { count })}
                {model.blocked === 'absent' && ` ${t('artifacts.legacy.connect', { count })}`}
              </p>
            </div>
            <details className="group">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
                {t('artifacts.legacy.list', { count, size: formatBytes(total) })}
              </summary>
              <ul className="mt-2">
                {items.map((item) => (
                  <LegacyArtifactRow key={item.id} item={item} trailing={item.shared ? <SharedTag /> : null} />
                ))}
              </ul>
            </details>
            <div className="flex flex-wrap items-center gap-1.5">
              {model.blocked !== 'absent' && (
                <Button
                  size="sm"
                  data-testid="artifacts-legacy-move"
                  disabled={model.blocked !== null || running}
                  aria-describedby={model.blocked ? 'legacy-artifacts-note' : undefined}
                  onClick={() => setMoving(true)}
                >
                  <ArrowRight className="size-3.5" />
                  {model.enableFirst ? t('artifacts.legacy.moveEnable') : t('artifacts.legacy.move')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                data-testid="artifacts-legacy-delete"
                disabled={running}
                onClick={() => setDeleting('ask')}
              >
                <Trash2 className="size-3.5" /> {t('artifacts.legacy.delete')}
              </Button>
            </div>
            {model.blocked && model.blocked !== 'absent' && (
              <p id="legacy-artifacts-note" className="text-[11.5px] text-muted-foreground">
                {t(`artifacts.legacy.blocked.${model.blocked}`)}
              </p>
            )}
          </div>
        </section>
      )}
      {dialogOpen && (
        <MoveArtifactsDialog
          items={items}
          server={server}
          move={move}
          onClose={() => setMoving(false)}
          onRaiseLimit={() => {
            setMoving(false)
            onRaiseLimit()
          }}
          onOpenCenter={
            onOpenCenter &&
            (() => {
              setMoving(false)
              onOpenCenter()
            })
          }
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('artifacts.legacy.deleteTitle', { count })}
          message={t('artifacts.legacy.deleteText')}
          confirmLabel={t('artifacts.legacy.deleteConfirm', { count })}
          destructive
          busy={deleting === 'busy'}
          error={deleteError}
          onCancel={() => deleting !== 'busy' && setDeleting(null)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  )
}

/** In the Artifacts center: a reminder that some artifacts are still on this computer, with the way to move them. */
export function LegacyArtifactsBanner({ count, onOpenSettings }: { count: number; onOpenSettings: () => void }) {
  const { t } = useTranslation('ui')
  if (!count) return null
  return (
    <div
      role="status"
      data-testid="artifacts-legacy-banner"
      className="mb-[18px] flex flex-wrap items-center gap-3 rounded-[10px] border border-artifact-warn/30 bg-artifact-warn/[0.08] px-3.5 py-2.5"
    >
      <Laptop className="size-4 shrink-0 text-artifact-warn" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[12.5px] text-foreground/85">{t('artifacts.legacy.title', { count })}</p>
      <Button size="sm" variant="outline" onClick={onOpenSettings}>
        {t('artifacts.legacy.review')}
      </Button>
    </div>
  )
}
