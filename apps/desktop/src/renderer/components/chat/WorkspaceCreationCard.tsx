import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, CircleAlert, CircleCheck, FolderGit2, FolderOpen, Loader2 } from 'lucide-react'
import { toolOutputText, type MessagePart } from '../../../shared/chat'
import {
  parseWorkspaceCreationResult,
  PROJECTS_DIRECTORY_ERROR_CODES,
  type WorkspaceCreationProgress,
  type WorkspaceCreationResult,
} from '../../../shared/workspace-creation'
import { cn } from '@/lib/utils'
import { ToolCallCard } from './ToolCallCard'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

/** Ask the app shell to show a workspace in the sidebar (handled in DesktopApp). */
function focusWorkspace(workspaceId: string): void {
  window.dispatchEvent(new CustomEvent('maestrly:focus-workspace', { detail: { workspaceId } }))
}

function inputOf(part: ToolPart): { requestKey?: string; name?: string; kind?: string; label?: string } {
  const input = (part.input ?? {}) as Record<string, unknown>
  const source = (input.source ?? {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  return {
    requestKey: text(input.requestKey),
    name: text(input.name),
    kind: text(source.kind),
    label: text(source.repo) ?? text(source.url) ?? text(input.name),
  }
}

function SetProjectsFolder() {
  const { t } = useTranslation('chat')
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            const result = await window.api.pickProjectsDirectory()
            if (result.ok && result.path) setSaved(result.path)
            else if (result.error) setError(result.error)
          } finally {
            setBusy(false)
          }
        }}
        className="flex w-fit items-center gap-1.5 rounded-md border border-white/[0.1] px-2.5 py-1 text-[12px] text-foreground hover:bg-white/[0.06] disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
        {t('workspaceCreation.setFolder')}
      </button>
      {saved && <p className="break-all text-[11px] text-muted-foreground">{t('workspaceCreation.folderSet', { path: saved })}</p>}
      {error && <p className="break-words text-[11px] text-amber-200/80">{error}</p>}
    </div>
  )
}

/** Result of create_workspace: the project created or cloned from this chat, with its progress while it runs. */
export function WorkspaceCreationCard({
  part,
  conversationId,
  messageId,
}: {
  part: ToolPart
  conversationId: string
  messageId: string
}) {
  const { t } = useTranslation(['chat', 'ui'])
  const input = inputOf(part)
  const running =
    part.state.status === 'pending' || part.state.status === 'running' || part.state.status === 'awaiting-permission'
  const [progress, setProgress] = useState<WorkspaceCreationProgress | null>(null)

  useEffect(() => {
    if (!running || !input.requestKey) return
    return window.api.onWorkspaceCreationProgress((next) => {
      if (next.conversationId === conversationId && next.requestKey === input.requestKey) setProgress(next)
    })
  }, [running, conversationId, input.requestKey])

  if (running) {
    const phase =
      progress?.phase === 'creating-remote'
        ? t('chat:workspaceCreation.creatingRemote')
        : progress
          ? t(`ui:projectSetup.phases.${progress.phase}`)
          : t('chat:workspaceCreation.running')
    return (
      <div
        data-testid="workspace-creation-card"
        className="flex min-w-0 max-w-full flex-col gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[12px] text-muted-foreground"
      >
        <div className="flex items-center gap-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span className="truncate text-foreground">{input.label ?? input.name}</span>
          <span className="shrink-0">
            {phase}
            {progress?.percent !== undefined && progress.phase !== 'completed' ? ` ${progress.percent}%` : ''}
          </span>
        </div>
        {progress?.path && <p className="truncate pl-5 text-[11px]">{progress.path}</p>}
      </div>
    )
  }

  const result: WorkspaceCreationResult | null =
    part.state.status === 'completed' ? parseWorkspaceCreationResult(toolOutputText(part.state.output)) : null
  if (!result) return <ToolCallCard part={part} conversationId={conversationId} messageId={messageId} />
  const origin = result.source
    ? t(`chat:workspaceCreation.source.${result.source.kind}`, { label: result.source.label })
    : null

  return (
    <div
      data-testid="workspace-creation-card"
      className="min-w-0 max-w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
    >
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <FolderGit2 className="size-3.5" />
        {t('chat:workspaceCreation.cardTitle')}
      </div>
      <div className="flex items-start gap-2 text-[13px]">
        {result.ok ? (
          <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
        ) : (
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-foreground">{result.name ?? input.name ?? input.label}</span>
            {(result.reused || result.replayed) && (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {result.replayed ? t('chat:workspaceCreation.replayed') : t('chat:workspaceCreation.reused')}
              </span>
            )}
          </div>
          {result.ok ? (
            <>
              {origin && <p className="truncate text-[11px] text-muted-foreground">{origin}</p>}
              {result.path && <p className="truncate text-[11px] text-muted-foreground">{result.path}</p>}
              {result.defaultBranch && (
                <p className="text-[11px] text-muted-foreground">
                  {t('chat:workspaceCreation.branch', { branch: result.defaultBranch })}
                </p>
              )}
              {result.remote && (
                <p
                  className={cn(
                    'break-words text-[11px]',
                    result.remote.status === 'created' ? 'text-muted-foreground' : 'text-amber-200/80'
                  )}
                >
                  {result.remote.status === 'created'
                    ? t('chat:workspaceCreation.remoteCreated', { url: result.remote.url ?? '' })
                    : t('chat:workspaceCreation.remoteFailed', { error: result.remote.error ?? '' })}
                </p>
              )}
            </>
          ) : (
            <p className="break-words text-[12px] text-amber-200/90">
              <span className="font-medium">{t('chat:workspaceCreation.refused')}: </span>
              {result.error}
            </p>
          )}
          {!result.ok && result.code && PROJECTS_DIRECTORY_ERROR_CODES.includes(result.code) && <SetProjectsFolder />}
        </div>
        {result.ok && result.workspaceId && (
          <button
            type="button"
            onClick={() => focusWorkspace(result.workspaceId!)}
            className="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-white/[0.06]"
          >
            {t('chat:workspaceCreation.show')} <ArrowUpRight className="size-3" />
          </button>
        )}
      </div>
    </div>
  )
}
