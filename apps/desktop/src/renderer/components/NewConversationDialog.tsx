import { useEffect, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, FolderGit2, FolderPlus, RotateCw, X } from 'lucide-react'
import type {
  BranchInfo,
  Conversation,
  Workspace,
  WorkspaceWithConversations,
  CreateConvRepo,
  LocalBranchIntent,
  LocalConversationConfirmResult,
  ConversationExperience,
} from '../../preload'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { LocalConversationPreview } from '@/components/local-conversation/LocalConversationPreview'
import { initialLocalConversationFlow, localConversationFlowReducer } from '@/components/local-conversation/flow'

function cleanError(e: unknown): string {
  let msg = String((e as { message?: string })?.message ?? e)
  msg = msg.replace(/^Error invoking remote method '[^']*':\s*/, '')
  msg = msg.replace(/^(Error:\s*)+/, '')
  return msg.trim()
}

interface Props {
  workspaceId: string | null
  workspaces: WorkspaceWithConversations[]
  requestProject: () => Promise<Workspace | null>
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (conversation: Conversation) => void
}

type BranchMode = 'existing' | 'new'
type RunMode = 'worktree' | 'local'
type Branches = BranchInfo & { defaultBranch: string }

const localChoice = (name: string) => `local:${name}`
const remoteChoice = (ref: string) => `remote:${ref}`

function branchChoice(info: Branches, name: string): string {
  if (info.local.includes(name)) return localChoice(name)
  const remote = info.remoteRefs.find((item) => item.name === name)
  return remote ? remoteChoice(remote.ref) : localChoice(name)
}

function choiceName(choice: string): string {
  if (choice.startsWith('local:')) return choice.slice('local:'.length)
  const ref = choice.slice('remote:'.length)
  return ref.replace(/^refs\/remotes\/[^/]+\//, '')
}

function localRefForChoice(info: Branches, choice: string) {
  if (choice.startsWith('local:')) return { kind: 'local' as const, name: choiceName(choice) }
  const ref = choice.slice('remote:'.length)
  const remote = info.remoteRefs.find((item) => item.ref === ref)
  if (!remote) throw new Error(`Remote reference not found: ${ref}`)
  return { kind: 'remote' as const, ...remote }
}

export function NewConversationDialog({
  workspaceId,
  workspaces,
  requestProject,
  open,
  onOpenChange,
  onCreated,
}: Props) {
  const { t } = useTranslation('ui')
  const [selected, setSelected] = useState<string[]>([])
  const [branchesByWs, setBranchesByWs] = useState<Record<string, Branches>>({})

  const [branchMode, setBranchMode] = useState<BranchMode>('new')
  const [existingBranch, setExistingBranch] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [base, setBase] = useState('')
  const [useCurrentHead, setUseCurrentHead] = useState(true)
  const [runMode, setRunMode] = useState<RunMode>('worktree')
  const [experience, setExperience] = useState<ConversationExperience>('standard')
  const [localFlow, dispatchLocalFlow] = useReducer(localConversationFlowReducer, initialLocalConversationFlow)

  const [coord, setCoord] = useState('')
  const [cfg, setCfg] = useState<Record<string, { branch: string; base: string }>>({})

  const [busy, setBusy] = useState(false)
  const creatingRef = useRef(false)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isMulti = selected.length > 1

  async function fetchAll() {
    if (selected.length === 0) return
    setFetching(true)
    setError(null)
    try {
      await Promise.all(
        selected.map(async (wsId) => {
          const info = await window.api.fetchBranches(wsId)
          setBranchesByWs((prev) => ({ ...prev, [wsId]: info }))
        })
      )
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setFetching(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setError(null)
    setBranchMode('new')
    setExistingBranch('')
    setNewBranch('')
    setBase('')
    setUseCurrentHead(true)
    setRunMode('worktree')
    setExperience('standard')
    dispatchLocalFlow({ type: 'reset' })
    creatingRef.current = false
    setCoord('')
    setCfg({})
    setSelected(workspaceId ? [workspaceId] : workspaces[0] ? [workspaces[0].id] : [])
  }, [open, workspaceId])

  useEffect(() => {
    if (!open) return
    const known = new Set(workspaces.map((workspace) => workspace.id))
    setSelected((current) => current.filter((id) => known.has(id)))
  }, [open, workspaces])

  useEffect(() => {
    const primaryId = selected[0]
    if (primaryId && branchesByWs[primaryId]) {
      const info = branchesByWs[primaryId]
      setBase(branchChoice(info, info.defaultBranch))
      setExistingBranch(branchChoice(info, info.current || info.local[0] || info.defaultBranch))
    }
    for (const wsId of selected) {
      if (branchesByWs[wsId]) continue
      window.api
        .getBranches(wsId)
        .then((info) => {
          setBranchesByWs((prev) => ({ ...prev, [wsId]: info }))
          setCfg((prev) => (prev[wsId] ? prev : { ...prev, [wsId]: { branch: coord, base: info.defaultBranch } }))
          if (wsId === primaryId) {
            setBase(branchChoice(info, info.defaultBranch))
            setExistingBranch(branchChoice(info, info.current || info.local[0] || info.defaultBranch))
          }
        })
        .catch((e) => setError(cleanError(e)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  function removeRepo(wsId: string) {
    setSelected((prev) => prev.filter((x) => x !== wsId))
  }
  function addExisting(wsId: string) {
    setSelected((prev) => (prev.includes(wsId) ? prev : [...prev, wsId]))
  }

  function onCoordChange(v: string) {
    setCoord(v)

    setCfg((prev) => {
      const next = { ...prev }
      for (const wsId of selected) next[wsId] = { ...next[wsId], branch: v, base: next[wsId]?.base ?? '' }
      return next
    })
  }

  async function addRepo() {
    const workspace = await requestProject()
    if (!workspace) return
    setSelected((current) => (current.includes(workspace.id) ? current : [...current, workspace.id]))
  }

  function finishCreated(conv: Conversation) {
    onCreated(conv)
    onOpenChange(false)
    setNewBranch('')
    setBranchMode('new')
    dispatchLocalFlow({ type: 'reset' })
  }

  function buildLocalIntent(info: Branches): LocalBranchIntent {
    if (branchMode === 'new') {
      const branch = newBranch.trim()
      if (useCurrentHead) return { type: 'create-from-head', branch }
      return { type: 'create-from-ref', branch, ref: localRefForChoice(info, base) }
    }
    const ref = localRefForChoice(info, existingBranch)
    return { type: 'switch-existing', branch: choiceName(existingBranch), ref }
  }

  function finishLocalConfirmation(result: LocalConversationConfirmResult) {
    if (result.status === 'created') {
      dispatchLocalFlow({ type: 'created', warning: result.warning, stashOid: result.stashOid })
      if (result.warning) window.alert(result.warning)
      finishCreated(result.conversation as Conversation)
    } else if (result.status === 'stale') {
      dispatchLocalFlow({
        type: 'preview',
        token: result.token,
        preview: result.preview,
        message: result.message,
      })
    } else if (result.status === 'blocked') {
      dispatchLocalFlow({ type: 'blocked', preview: result.preview, blockers: result.blockers })
    } else if (result.status === 'recovery-required') {
      dispatchLocalFlow({ type: 'recovery', preview: result.preview, recovery: result.recovery })
    } else {
      setError(result.message)
      dispatchLocalFlow({ type: 'reset' })
    }
  }

  async function handleCreate() {
    if (creatingRef.current) return
    if (selected.length === 0) {
      setError(t('newConv.errSelectRepo'))
      return
    }
    creatingRef.current = true
    setBusy(true)
    setError(null)
    try {
      if (isMulti) {
        const repos: CreateConvRepo[] = selected.map((wsId) => ({
          workspaceId: wsId,
          branch: (cfg[wsId]?.branch || coord).trim(),
          isNewBranch: true,
          base: cfg[wsId]?.base || branchesByWs[wsId]?.defaultBranch,
        }))
        if (repos.some((r) => !r.branch)) {
          setError(t('newConv.errCoordBranch'))
          return
        }
        finishCreated(
          await window.api.createConversation({
            workspaceId: selected[0],
            branch: repos[0].branch,
            isNewBranch: true,
            mode: 'worktree',
            experience,
            repos,
          })
        )
        return
      }

      const wsId = selected[0]
      const info = branchesByWs[wsId]
      const branch = branchMode === 'new' ? newBranch.trim() : choiceName(existingBranch)
      if (!branch || !info) {
        setError(t('newConv.errBranch'))
        return
      }
      if (runMode === 'local') {
        if (branchMode === 'new' && !useCurrentHead && !base) {
          setError(t('newConv.errBase'))
          return
        }
        dispatchLocalFlow({ type: 'prepare' })
        const result = await window.api.prepareLocalConversation({
          workspaceId: wsId,
          experience,
          intent: buildLocalIntent(info),
        })
        if (result.status === 'ready') {
          if (result.requiresConfirmation) {
            dispatchLocalFlow({ type: 'preview', token: result.token, preview: result.preview })
          } else {
            finishLocalConfirmation(await window.api.confirmLocalConversation({ token: result.token }))
          }
        } else if (result.status === 'blocked') {
          dispatchLocalFlow({
            type: 'blocked',
            preview: result.preview,
            blockers: result.blockers,
          })
        } else {
          setError(result.message)
          dispatchLocalFlow({ type: 'reset' })
        }
        return
      }
      finishCreated(
        await window.api.createConversation({
          workspaceId: wsId,
          branch,
          isNewBranch: branchMode === 'new',

          base: branchMode === 'new' && base ? choiceName(base) : undefined,
          mode: 'worktree',
          experience,
        })
      )
    } catch (e) {
      setError(cleanError(e))
      dispatchLocalFlow({ type: 'reset' })
    } finally {
      creatingRef.current = false
      setBusy(false)
    }
  }

  async function handleConfirmLocal() {
    if (localFlow.step !== 'preview' || creatingRef.current) return
    creatingRef.current = true
    setBusy(true)
    setError(null)
    dispatchLocalFlow({ type: 'confirm' })
    try {
      const result = await window.api.confirmLocalConversation({ token: localFlow.token })
      finishLocalConfirmation(result)
    } catch (e) {
      setError(cleanError(e))
      dispatchLocalFlow({ type: 'reset' })
    } finally {
      creatingRef.current = false
      setBusy(false)
    }
  }

  const single = branchesByWs[selected[0]] ?? null
  const branchOptions = single
    ? [
        ...single.local.map((name) => ({ id: localChoice(name), label: name })),
        ...single.remoteRefs.map((item) => ({
          id: remoteChoice(item.ref),
          label: `${item.name} (${item.remote})`,
        })),
      ]
    : []
  const showingLocalStep =
    localFlow.step === 'preview' ||
    localFlow.step === 'confirming' ||
    localFlow.step === 'blocked' ||
    localFlow.step === 'recovery'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            if (!showingLocalStep) void handleCreate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{showingLocalStep ? t('newConv.localPreviewTitle') : t('newConv.title')}</DialogTitle>
            <DialogDescription>
              {showingLocalStep ? t('newConv.localPreviewDesc') : t('newConv.desc')}
            </DialogDescription>
          </DialogHeader>

          {showingLocalStep ? (
            <LocalConversationPreview
              preview={localFlow.preview}
              blockers={localFlow.step === 'blocked' ? localFlow.blockers : undefined}
              recovery={localFlow.step === 'recovery' ? localFlow.recovery : undefined}
              message={localFlow.step === 'preview' ? localFlow.message : undefined}
              onOpenTerminal={
                localFlow.step === 'recovery'
                  ? () => void window.api.openExternal('workspace', selected[0], 'terminal')
                  : undefined
              }
              onCopyCommands={
                localFlow.step === 'recovery'
                  ? () => void navigator.clipboard.writeText(localFlow.recovery.commands.join('\n'))
                  : undefined
              }
            />
          ) : (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex flex-col gap-1.5">
                <Label>{t('newConv.experience')}</Label>
                <div className="grid grid-cols-2 gap-2">
                  <ModeCard
                    title={t('newConv.standardTitle')}
                    desc={t('newConv.standardDesc')}
                    active={experience === 'standard'}
                    onClick={() => setExperience('standard')}
                  />
                  <ModeCard
                    title={t('newConv.maestroTitle')}
                    desc={t('newConv.maestroDesc')}
                    active={experience === 'maestro'}
                    onClick={() => setExperience('maestro')}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label>{t('newConv.repos')}</Label>
                  <button
                    type="button"
                    onClick={fetchAll}
                    disabled={fetching || selected.length === 0}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    title={t('newConv.fetchHint')}
                  >
                    <RotateCw className={cn('size-3', fetching && 'animate-spin')} />
                    {fetching ? t('newConv.fetching') : t('newConv.fetchBranches')}
                  </button>
                </div>
                <div className="flex flex-col gap-1">
                  {selected.map((wsId, i) => {
                    const w = workspaces.find((x) => x.id === wsId)
                    const primary = i === 0
                    return (
                      <div
                        key={wsId}
                        className="flex items-center gap-2 rounded-lg border border-ring bg-sidebar-accent px-2.5 py-1.5 text-sm"
                      >
                        <FolderGit2 className="size-4 shrink-0 opacity-60" />
                        <span className="min-w-0 flex-1 truncate">{w?.name ?? wsId}</span>
                        {primary ? (
                          <span className="shrink-0 rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {t('newConv.conversationBadge')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => removeRepo(wsId)}
                            title={t('newConv.removeRepo')}
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                          >
                            <X className="size-3.5" />
                          </button>
                        )}
                      </div>
                    )
                  })}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="mt-0.5 justify-start gap-1.5 text-muted-foreground"
                      >
                        <Plus className="size-3.5" /> {t('newConv.addRepo')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-52">
                      {workspaces
                        .filter((w) => !selected.includes(w.id))
                        .map((w) => (
                          <DropdownMenuItem key={w.id} onClick={() => addExisting(w.id)}>
                            <FolderGit2 className="mr-2 size-3.5 opacity-60" />
                            {w.name}
                          </DropdownMenuItem>
                        ))}
                      {workspaces.some((w) => !selected.includes(w.id)) && <DropdownMenuSeparator />}
                      <DropdownMenuItem onClick={() => void addRepo()}>
                        <FolderPlus className="mr-2 size-3.5 opacity-60" />
                        {t('newConv.chooseFolder')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {isMulti ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="coord-branch">{t('newConv.coordBranchLabel')}</Label>
                    <Input
                      id="coord-branch"
                      placeholder={t('newConv.branchPlaceholder')}
                      value={coord}
                      onChange={(e) => onCoordChange(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    {selected.map((wsId) => {
                      const w = workspaces.find((x) => x.id === wsId)
                      const b = branchesByWs[wsId]
                      const all = b ? [...b.local, ...b.remote] : []
                      return (
                        <div
                          key={wsId}
                          className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-lg border border-input p-2"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium">{w?.name}</div>
                            <Input
                              className="mt-1 h-7 text-xs"
                              value={cfg[wsId]?.branch ?? coord}
                              onChange={(e) =>
                                setCfg((prev) => ({
                                  ...prev,
                                  [wsId]: { ...prev[wsId], branch: e.target.value, base: prev[wsId]?.base ?? '' },
                                }))
                              }
                            />
                          </div>
                          <div className="w-36">
                            <Label className="text-[10px] text-muted-foreground">{t('newConv.fromLabel')}</Label>
                            <Select
                              value={cfg[wsId]?.base ?? b?.defaultBranch ?? ''}
                              onValueChange={(v) =>
                                setCfg((prev) => ({
                                  ...prev,
                                  [wsId]: { ...prev[wsId], base: v, branch: prev[wsId]?.branch ?? coord },
                                }))
                              }
                            >
                              <SelectTrigger className="h-7 text-xs">
                                <SelectValue placeholder={t('newConv.basePlaceholder')} />
                              </SelectTrigger>
                              <SelectContent>
                                {all.map((br) => (
                                  <SelectItem key={br} value={br}>
                                    {br}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={branchMode === 'new' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setBranchMode('new')}
                    >
                      {t('newConv.newBranch')}
                    </Button>
                    <Button
                      type="button"
                      variant={branchMode === 'existing' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setBranchMode('existing')}
                    >
                      {t('newConv.existingBranch')}
                    </Button>
                  </div>
                  {branchMode === 'new' ? (
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="new-branch">{t('newConv.newBranchName')}</Label>
                        <Input
                          id="new-branch"
                          placeholder={t('newConv.branchPlaceholder')}
                          value={newBranch}
                          onChange={(e) => setNewBranch(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>{t('newConv.createFrom')}</Label>
                        {runMode === 'local' && (
                          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-input px-2 py-2 text-xs">
                            <input
                              type="checkbox"
                              checked={useCurrentHead}
                              onChange={(event) => setUseCurrentHead(event.target.checked)}
                            />
                            {t('newConv.currentHead')}
                          </label>
                        )}
                        {(runMode !== 'local' || !useCurrentHead) && (
                          <SearchSelect
                            value={base || undefined}
                            options={branchOptions}
                            placeholder={t('newConv.baseBranchPlaceholder')}
                            onChange={(id) => setBase(id ?? '')}
                          />
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <Label>{t('newConv.branch')}</Label>
                      <SearchSelect
                        value={existingBranch || undefined}
                        options={branchOptions}
                        placeholder={t('newConv.selectBranchPlaceholder')}
                        onChange={(id) => setExistingBranch(id ?? '')}
                      />
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label>{t('newConv.workMode')}</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <ModeCard
                        title={t('newConv.worktreeTitle')}
                        desc={t('newConv.worktreeDesc')}
                        active={runMode === 'worktree'}
                        onClick={() => setRunMode('worktree')}
                      />
                      <ModeCard
                        title={t('newConv.localTitle')}
                        desc={t('newConv.localDesc')}
                        active={runMode === 'local'}
                        onClick={() => setRunMode('local')}
                      />
                    </div>
                  </div>
                </>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          )}

          <DialogFooter>
            {showingLocalStep ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => dispatchLocalFlow({ type: 'reset' })}
                  disabled={busy}
                >
                  {t('newConv.backToForm')}
                </Button>
                {localFlow.step === 'preview' && (
                  <Button type="button" onClick={handleConfirmLocal} disabled={busy}>
                    {busy ? t('newConv.creating') : t('newConv.confirmLocal')}
                  </Button>
                )}
                {localFlow.step === 'blocked' && (
                  <Button type="button" onClick={handleCreate} disabled={busy}>
                    {t('newConv.retryPreview')}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={busy || selected.length === 0}>
                  {busy
                    ? t('newConv.creating')
                    : isMulti
                      ? t('newConv.createMulti', { count: selected.length })
                      : t('newConv.createChat')}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ModeCard({
  title,
  desc,
  active,
  onClick,
}: {
  title: string
  desc: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col gap-1 rounded-lg border p-3 text-left transition-all duration-150',
        active ? 'border-ring bg-sidebar-accent' : 'border-input hover:bg-white/5'
      )}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{desc}</span>
    </button>
  )
}
