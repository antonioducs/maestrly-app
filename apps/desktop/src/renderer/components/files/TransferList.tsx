import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Folder,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Replace,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HOST_TRANSFER_FINAL_STATES, type HostTransferView } from '../../../shared/host-transfers'
import { transferDetail, transferProgress, transferStageLabel } from './files-model'

function Action({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 shrink-0"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

/** The transfers of a host: their progress, what stopped them, and what can be done with each. */
export function TransferList({ transfers }: { transfers: HostTransferView[] }) {
  const { t, i18n } = useTranslation('ui')
  const finished = transfers.filter((transfer) => HOST_TRANSFER_FINAL_STATES.has(transfer.state))
  return (
    <section
      aria-label={t('files.transfers.title')}
      className="flex max-h-[40%] shrink-0 flex-col border-t border-border/60"
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <h2 className="text-xs font-medium">{t('files.transfers.title')}</h2>
        {finished.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-[11px]"
            onClick={() => {
              for (const transfer of finished) void window.api.transfersRemove(transfer.id)
            }}
          >
            {t('files.transfers.clear')}
          </Button>
        )}
      </div>
      <ul className="min-h-0 overflow-y-auto pb-1">
        {transfers.length === 0 && (
          <li className="px-2.5 py-1 text-xs text-muted-foreground">{t('files.transfers.empty')}</li>
        )}
        {transfers.map((transfer) => {
          const active = transfer.state === 'queued' || transfer.state === 'running' || transfer.state === 'waiting'
          const final = HOST_TRANSFER_FINAL_STATES.has(transfer.state)
          const progress = transferProgress(transfer)
          const stage = transferStageLabel(transfer)
          const Direction = transfer.direction === 'download' ? ArrowDownToLine : ArrowUpFromLine
          return (
            <li
              key={transfer.id}
              data-transfer={transfer.name}
              data-transfer-state={transfer.state}
              className="flex flex-col gap-1 px-2.5 py-1.5 text-xs"
            >
              <div className="flex items-center gap-1.5">
                <Direction
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-label={t(
                    transfer.direction === 'download' ? 'files.transfers.download' : 'files.transfers.upload'
                  )}
                />
                {transfer.kind === 'folder' && (
                  <Folder
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label={t('files.transfers.folder')}
                  />
                )}
                <span className="min-w-0 flex-1 truncate" title={transfer.remotePath}>
                  {transfer.name}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {t(stage ? `files.transfers.stages.${stage}` : `files.transfers.states.${transfer.state}`)}
                </span>
                {active && (
                  <Action
                    label={t('files.transfers.pause')}
                    onClick={() => void window.api.transfersPause(transfer.id)}
                  >
                    <Pause className="size-3.5" />
                  </Action>
                )}
                {transfer.state === 'paused' && (
                  <Action
                    label={t('files.transfers.resume')}
                    onClick={() => void window.api.transfersResume(transfer.id)}
                  >
                    <Play className="size-3.5" />
                  </Action>
                )}
                {(active || transfer.state === 'paused') && (
                  <Action
                    label={t('files.transfers.cancel')}
                    onClick={() => void window.api.transfersCancel(transfer.id)}
                  >
                    <X className="size-3.5" />
                  </Action>
                )}
                {transfer.state === 'failed' && (
                  <Action
                    label={t('files.transfers.retry')}
                    onClick={() => void window.api.transfersRetry(transfer.id)}
                  >
                    <RotateCcw className="size-3.5" />
                  </Action>
                )}
                {transfer.state === 'failed' && transfer.error === 'exists' && transfer.direction === 'upload' && (
                  <Action
                    label={t('files.transfers.replace')}
                    onClick={() => void window.api.transfersRetry(transfer.id, { overwrite: true })}
                  >
                    <Replace className="size-3.5" />
                  </Action>
                )}
                {transfer.state === 'done' && transfer.direction === 'download' && (
                  <Action
                    label={t('files.transfers.reveal')}
                    onClick={() => void window.api.transfersReveal(transfer.id)}
                  >
                    <FolderOpen className="size-3.5" />
                  </Action>
                )}
                {final && (
                  <Action
                    label={t('files.transfers.remove')}
                    onClick={() => void window.api.transfersRemove(transfer.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Action>
                )}
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress === null ? undefined : Math.round(progress)}
                className="h-1.5 overflow-hidden rounded-full bg-white/10"
              >
                <div
                  className={`h-full rounded-full ${transfer.state === 'failed' ? 'bg-destructive' : 'bg-primary'} ${
                    progress === null ? 'w-1/3 animate-pulse' : ''
                  }`}
                  style={progress === null ? undefined : { width: `${progress}%` }}
                />
              </div>
              <div className="text-[11px] text-muted-foreground">{transferDetail(transfer, i18n.language, t)}</div>
              {transfer.error && (
                <p
                  role="alert"
                  className="text-[11px] text-destructive"
                  title={transfer.error === 'unknown' ? (transfer.errorMessage ?? undefined) : undefined}
                >
                  {t(`files.transfers.errors.${transfer.error}`)}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
