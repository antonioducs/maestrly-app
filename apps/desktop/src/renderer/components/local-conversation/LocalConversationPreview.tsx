import { AlertTriangle, GitBranch, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  LocalConversationBlocker,
  LocalConversationPreview as Preview,
  LocalConversationRecovery,
} from '../../../shared/local-conversation'
import { Button } from '@/components/ui/button'

interface Props {
  preview: Preview
  blockers?: LocalConversationBlocker[]
  recovery?: LocalConversationRecovery
  message?: string
  onOpenTerminal?: () => void
  onCopyCommands?: () => void
}

const shortOid = (oid: string) => oid.slice(0, 10)

export function LocalConversationPreview({
  preview,
  blockers = preview.blockers,
  recovery,
  message,
  onOpenTerminal,
  onCopyCommands,
}: Props) {
  const { t } = useTranslation('ui')
  return (
    <div className="flex flex-col gap-3 text-sm">
      {message && (
        <div className="rounded-md border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-200">
          {message}
        </div>
      )}
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border p-3 text-xs">
        <span className="text-muted-foreground">{t('newConv.localCurrent')}</span>
        <span className="font-mono">
          {preview.currentBranch || 'detached'} · {shortOid(preview.headOid)}
        </span>
        <span className="text-muted-foreground">{t('newConv.localTarget')}</span>
        <span className="font-mono">
          {preview.targetBranch} · {shortOid(preview.targetOid)}
        </span>
        <span className="text-muted-foreground">{t('newConv.localStrategy')}</span>
        <span>{t(`newConv.strategy.${preview.strategy}`)}</span>
      </div>

      {blockers.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <div className="mb-2 flex items-center gap-1.5 font-medium text-destructive">
            <ShieldAlert className="size-4" /> {t('newConv.localBlocked')}
          </div>
          <ul className="space-y-1 text-xs">
            {blockers.map((blocker, index) => (
              <li key={`${blocker.code}-${index}`}>
                {blocker.message}
                {blocker.paths?.length ? (
                  <div className="mt-1 font-mono text-muted-foreground">{blocker.paths.join('\n')}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.activity.some((item) => !item.blocking) && (
        <div className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {t('newConv.localIdleWarning')}
        </div>
      )}

      {(['staged', 'unstaged', 'untracked'] as const).map((kind) => (
        <ChangeList key={kind} title={t(`newConv.${kind}`)} files={preview.changes[kind]} />
      ))}

      {preview.strategy === 'stash-switch-apply' && !recovery && (
        <p className="text-xs text-muted-foreground">{t('newConv.localStashWarning')}</p>
      )}

      {recovery && (
        <div className="rounded-md border border-amber-400/40 bg-amber-400/10 p-3 text-xs">
          <div className="mb-2 flex items-center gap-1.5 font-medium text-amber-200">
            <GitBranch className="size-4" /> {t('newConv.recoveryTitle')}
          </div>
          <p>{recovery.message}</p>
          {recovery.stashOid && (
            <p className="mt-2 font-mono">
              {t('newConv.stashOid')}: {recovery.stashOid}
            </p>
          )}
          <pre className="mt-2 overflow-x-auto rounded bg-black/30 p-2">{recovery.commands.join('\n')}</pre>
          <div className="mt-2 flex gap-2">
            {onOpenTerminal && (
              <Button type="button" size="sm" variant="outline" onClick={onOpenTerminal}>
                {t('newConv.openTerminal')}
              </Button>
            )}
            {onCopyCommands && (
              <Button type="button" size="sm" variant="outline" onClick={onCopyCommands}>
                {t('newConv.copyCommands')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ChangeList({ title, files }: { title: string; files: string[] }) {
  if (files.length === 0) return null
  return (
    <div>
      <div className="mb-1 text-xs font-medium">
        {title} ({files.length})
      </div>
      <div className="max-h-28 overflow-y-auto rounded border border-border bg-black/20 p-2 font-mono text-[11px]">
        {files.map((file) => (
          <div key={file}>{file}</div>
        ))}
      </div>
    </div>
  )
}
