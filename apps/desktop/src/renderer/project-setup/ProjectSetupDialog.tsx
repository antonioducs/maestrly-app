import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderGit2, FolderPlus, GitFork, LoaderCircle } from 'lucide-react'
import type { ProjectSetupErrorCode, ProjectSetupRequest } from '../../shared/project-setup'
import { isSafeProjectName, suggestProjectName } from '../../shared/project-setup'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { ProjectSetupDialogState, ProjectSetupMode } from './use-project-setup'

interface Props {
  state: ProjectSetupDialogState
  onModeChange: (mode: ProjectSetupMode) => void
  onStart: (request: ProjectSetupRequest) => Promise<unknown>
  onResolveEmptyRemote: (decision: 'initialize-local' | 'cancel') => Promise<void>
  onClose: () => Promise<void>
}

const MODES: Array<{ mode: ProjectSetupMode; icon: typeof FolderGit2 }> = [
  { mode: 'open', icon: FolderGit2 },
  { mode: 'create', icon: FolderPlus },
  { mode: 'clone', icon: GitFork },
]

function newOperationId(): string {
  return crypto.randomUUID()
}

export function ProjectSetupDialog({ state, onModeChange, onStart, onResolveEmptyRemote, onClose }: Props) {
  const { t } = useTranslation('ui')
  const [path, setPath] = useState('')
  const [parentPath, setParentPath] = useState('')
  const [name, setName] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const result = state.result

  useEffect(() => {
    if (!state.open) return
    setPath('')
    setParentPath('')
    setName(state.options.remoteUrl ? suggestProjectName(state.options.remoteUrl) : '')
    setRemoteUrl(state.options.remoteUrl ?? '')
    setNameEdited(false)
  }, [state.open, state.options.remoteUrl])

  const awaitingEmptyRemote = state.progress?.phase === 'awaiting-empty-remote-confirmation'
  const needsInitialization = result?.status === 'needs-initialization'
  const errorCode = result?.status === 'error' ? result.error.code : null
  const percent = state.progress?.percent
  const canSubmit = useMemo(() => {
    if (state.busy) return false
    if (state.mode === 'open') return path.length > 0
    if (!parentPath || !isSafeProjectName(name)) return false
    return state.mode === 'create' || remoteUrl.trim().length > 0
  }, [name, parentPath, path, remoteUrl, state.busy, state.mode])

  async function pick(purpose: 'open' | 'parent') {
    const selected = await window.api.pickProjectDirectory(purpose)
    if (selected) purpose === 'open' ? setPath(selected) : setParentPath(selected)
  }

  function updateRemoteUrl(value: string) {
    setRemoteUrl(value)
    if (!nameEdited) setName(suggestProjectName(value))
  }

  async function submit() {
    const operationId = newOperationId()
    if (state.mode === 'open') {
      await onStart({ operationId, kind: 'open', path })
    } else if (state.mode === 'create') {
      await onStart({ operationId, kind: 'create', parentPath, name })
    } else {
      await onStart({
        operationId,
        kind: 'clone',
        parentPath,
        name,
        remoteUrl,
        defaultBranch: state.options.defaultBranch,
      })
    }
  }

  return (
    <Dialog open={state.open} onOpenChange={(open) => !open && void onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('projectSetup.title')}</DialogTitle>
          <DialogDescription>{t('projectSetup.description')}</DialogDescription>
        </DialogHeader>

        <div
          className={cn('grid gap-2', state.options.allowedModes ? 'grid-cols-2' : 'grid-cols-3')}
          role="group"
          aria-label={t('projectSetup.modeLabel')}
        >
          {MODES.filter(({ mode }) => !state.options.allowedModes || state.options.allowedModes.includes(mode)).map(
            ({ mode, icon: Icon }) => (
              <button
                key={mode}
                type="button"
                aria-pressed={state.mode === mode}
                disabled={state.busy}
                onClick={() => onModeChange(mode)}
                className={cn(
                  'flex min-h-20 flex-col items-center justify-center gap-2 rounded-lg border px-2 text-xs transition-colors',
                  state.mode === mode
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'
                )}
              >
                <Icon className="size-5" />
                {t(`projectSetup.modes.${mode}`)}
              </button>
            )
          )}
        </div>

        <div className="flex flex-col gap-3">
          {state.mode === 'open' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project-setup-path">{t('projectSetup.folder')}</Label>
              <div className="flex gap-2">
                <Input
                  id="project-setup-path"
                  value={path}
                  readOnly
                  placeholder={t('projectSetup.folderPlaceholder')}
                />
                <Button variant="secondary" type="button" onClick={() => void pick('open')} disabled={state.busy}>
                  {t('projectSetup.choose')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {state.mode === 'clone' && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="project-setup-url">{t('projectSetup.remoteUrl')}</Label>
                    <Input
                      id="project-setup-url"
                      value={remoteUrl}
                      onChange={(event) => updateRemoteUrl(event.target.value)}
                      placeholder={t('projectSetup.remoteUrlPlaceholder')}
                      disabled={state.busy}
                    />
                  </div>
                  {state.options.defaultBranch && (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="project-setup-default-branch">{t('projectSetup.defaultBranch')}</Label>
                      <Input id="project-setup-default-branch" value={state.options.defaultBranch} disabled />
                    </div>
                  )}
                </>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="project-setup-parent">{t('projectSetup.parentFolder')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="project-setup-parent"
                    value={parentPath}
                    readOnly
                    placeholder={t('projectSetup.parentPlaceholder')}
                  />
                  <Button variant="secondary" type="button" onClick={() => void pick('parent')} disabled={state.busy}>
                    {t('projectSetup.choose')}
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="project-setup-name">{t('projectSetup.projectName')}</Label>
                <Input
                  id="project-setup-name"
                  value={name}
                  onChange={(event) => {
                    setNameEdited(true)
                    setName(event.target.value)
                  }}
                  placeholder={t('projectSetup.namePlaceholder')}
                  disabled={state.busy}
                />
              </div>
            </>
          )}
        </div>

        {state.progress && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-white/[0.02] p-3">
            <div className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
              <LoaderCircle className="size-4 animate-spin text-primary" />
              <span>{t(`projectSetup.phases.${state.progress.phase}`)}</span>
              {percent !== undefined && <span className="ml-auto tabular-nums text-muted-foreground">{percent}%</span>}
            </div>
            <div
              role="progressbar"
              aria-label={t('projectSetup.progressLabel')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1.5 overflow-hidden rounded-full bg-white/10"
            >
              <div
                className={cn('h-full bg-primary transition-[width]', percent === undefined && 'w-1/3 animate-pulse')}
                style={percent === undefined ? undefined : { width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        {needsInitialization && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
            <p>{t('projectSetup.initializeExisting')}</p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => void onClose()}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() =>
                  void onStart({
                    operationId: newOperationId(),
                    kind: 'initialize-existing',
                    path: result.path,
                  })
                }
              >
                {t('projectSetup.initializeAction')}
              </Button>
            </div>
          </div>
        )}

        {awaitingEmptyRemote && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
            <p>{t('projectSetup.emptyRemote')}</p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => void onResolveEmptyRemote('cancel')}>
                {t('projectSetup.emptyRemoteCancel')}
              </Button>
              <Button onClick={() => void onResolveEmptyRemote('initialize-local')}>
                {t('projectSetup.emptyRemoteInitialize')}
              </Button>
            </div>
          </div>
        )}

        {errorCode && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {t(`projectSetup.errors.${errorCode as ProjectSetupErrorCode}`)}
          </p>
        )}

        {!needsInitialization && !awaitingEmptyRemote && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => void onClose()}>
              {state.busy ? t('projectSetup.cancelOperation') : t('common.cancel')}
            </Button>
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {t(`projectSetup.actions.${state.mode}`)}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
