import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CloudDownload, FolderOpen, Link2, Loader2 } from 'lucide-react'
import type { Workspace } from '../../../preload'
import type { PlatformConnectionView, PlatformProjectBinding, RemotePlatformProject } from '../../../shared/platform'
import {
  suggestProjectName,
  type ProjectSetupPhase,
  type ProjectSetupRequest,
  type ProjectSetupResult,
} from '../../../shared/project-setup'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

const WITHOUT_CODE = 'without-code'

type Blocker = 'project' | 'board' | 'folder' | 'occupied' | 'repository' | 'saved'

/** Numbered step whose marker becomes a check once the step is complete. */
function Step({
  number,
  done,
  label,
  htmlFor,
  children,
}: {
  number: number
  done: boolean
  label: string
  htmlFor?: string
  children: ReactNode
}) {
  const marker = (
    <span
      aria-hidden="true"
      className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
        done ? 'bg-emerald-500/20 text-emerald-500' : 'border border-border text-muted-foreground'
      }`}
    >
      {done ? <Check size={12} /> : number}
    </span>
  )
  const title = htmlFor ? (
    <label htmlFor={htmlFor} className="text-xs font-medium">
      {label}
    </label>
  ) : (
    <span className="text-xs font-medium">{label}</span>
  )
  return (
    <div className="flex gap-3">
      <div className="pt-0.5">{marker}</div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex h-5 items-center">{title}</div>
        {children}
      </div>
    </div>
  )
}

class ProjectSetupFailed extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function ProjectBindingSection({ connections }: { connections: PlatformConnectionView[] }) {
  const { i18n, t } = useTranslation('ui')
  const L = (en: string, pt: string) => (i18n.language.startsWith('pt') ? pt : en)
  const id = useId()
  const pickFolderRef = useRef<HTMLButtonElement>(null)
  const [connectionId, setConnectionId] = useState('')
  const connection =
    connections.find((c) => c.id === connectionId && c.state === 'connected') ??
    connections.find((c) => c.state === 'connected')
  const [data, setData] = useState<{
    projects: RemotePlatformProject[]
    workspaces: Workspace[]
    bindings: PlatformProjectBinding[]
  }>({ projects: [], workspaces: [], bindings: [] })
  const [projectId, setProjectId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [repositoryId, setRepositoryId] = useState(WITHOUT_CODE)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState<'folder' | 'clone' | 'save' | 'remove' | null>(null)
  const [phase, setPhase] = useState<{ phase: ProjectSetupPhase; percent?: number } | null>(null)
  const operationRef = useRef<string | null>(null)

  useEffect(
    () =>
      window.api.onProjectSetupProgress((progress) => {
        if (progress.operationId !== operationRef.current) return
        setPhase({ phase: progress.phase, percent: progress.percent })
        // An empty remote is fine for a fresh project folder; never block on a question here.
        if (progress.phase === 'awaiting-empty-remote-confirmation') {
          void window.api.resolveEmptyRemoteProjectSetup(progress.operationId, 'initialize-local')
        }
      }),
    []
  )
  const [error, setError] = useState('')
  const [folderError, setFolderError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState(false)
  const [removed, setRemoved] = useState<PlatformProjectBinding | null>(null)

  useEffect(() => {
    if (!connection) return
    let active = true
    setLoading(true)
    setLoadError(false)
    setError('')
    setFolderError('')
    setNotice('')
    setWorkspaceId('')
    setRemoved(null)
    setEditing(false)
    void Promise.all([
      window.api.platformListRemoteProjects(connection.id),
      window.api.listWorkspaces(),
      window.api.platformListProjectBindings(),
    ])
      .then(([projects, workspaces, bindings]) => {
        if (!active) return
        setData({ projects, workspaces, bindings })
        const first = projects.length === 1 ? projects[0] : undefined
        setProjectId(first?.projectId ?? '')
        setRepositoryId(
          first?.repositories?.length === 1 ? first.repositories[0].id : first?.repositories?.length ? '' : WITHOUT_CODE
        )
      })
      .catch(() => {
        if (active) setLoadError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [connection?.id, revision])

  if (!connection) return null
  const project = data.projects.find((p) => p.projectId === projectId)
  const workspace = data.workspaces.find((w) => w.id === workspaceId)
  const repositories = project?.repositories ?? []
  const existing = data.bindings.find((b) => b.workspaceId === workspaceId)
  const occupied = !!existing && (existing.connectionId !== connection.id || existing.projectId !== projectId)
  const matchesSaved =
    !!existing &&
    !occupied &&
    existing.repositoryBindingId === (repositoryId === WITHOUT_CODE ? undefined : repositoryId)
  const linked = data.bindings.filter((b) => b.connectionId === connection.id)

  // The single reason the link cannot be saved right now, in step order. Shown proactively and on click.
  const blocker: Blocker | null = !project
    ? 'project'
    : !project.boards.length
      ? 'board'
      : !workspace
        ? 'folder'
        : occupied
          ? 'occupied'
          : !repositoryId
            ? 'repository'
            : matchesSaved
              ? 'saved'
              : null
  const blockerText: Record<Blocker, string> = {
    project: L('Select the Kanban project (step 1).', 'Selecione o projeto do Kanban (passo 1).'),
    board: L(
      'This project has no board yet. Create one in the Kanban first.',
      'Este projeto ainda não tem um quadro. Crie um no Kanban antes.'
    ),
    folder: L('Choose the folder on this computer (step 2).', 'Escolha a pasta neste computador (passo 2).'),
    occupied: L(
      'This folder is already linked to another project. Choose another folder or remove that link below.',
      'Esta pasta já está vinculada a outro projeto. Escolha outra pasta ou remova aquele vínculo abaixo.'
    ),
    repository: L('Select the code repository.', 'Selecione o repositório do código.'),
    saved: L('This folder is already linked to this project.', 'Esta pasta já está vinculada a este projeto.'),
  }

  function chooseProject(value: string) {
    const next = data.projects.find((p) => p.projectId === value)
    setProjectId(value)
    setWorkspaceId('')
    setNotice('')
    setError('')
    setFolderError('')
    setRepositoryId(
      next?.repositories?.length === 1 ? next.repositories[0].id : next?.repositories?.length ? '' : WITHOUT_CODE
    )
  }
  function chooseWorkspace(value: string) {
    setWorkspaceId(value)
    setNotice('')
    setError('')
    setFolderError('')
    const saved = data.bindings.find(
      (b) => b.workspaceId === value && b.connectionId === connection!.id && b.projectId === projectId
    )
    if (saved) setRepositoryId(saved.repositoryBindingId ?? WITHOUT_CODE)
  }
  async function act(kind: NonNullable<typeof busy>, operation: () => Promise<void>) {
    if (busy) return
    setBusy(kind)
    setError('')
    setFolderError('')
    setNotice('')
    try {
      await operation()
    } catch (e) {
      const message =
        e instanceof ProjectSetupFailed
          ? t(`projectSetup.errors.${e.code}`)
          : (e as Error).message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
      if (kind === 'folder' || kind === 'clone') setFolderError(message)
      else setError(message)
    } finally {
      setBusy(null)
      setPhase(null)
      operationRef.current = null
    }
  }
  /** Run one project-setup operation and return its workspace; throws ProjectSetupFailed on error. */
  async function runSetup(
    request: ProjectSetupRequest extends infer R ? (R extends unknown ? Omit<R, 'operationId'> : never) : never
  ): Promise<ProjectSetupResult<Workspace>> {
    const operationId = crypto.randomUUID()
    operationRef.current = operationId
    const result = await window.api.startProjectSetup({ ...request, operationId } as ProjectSetupRequest)
    if (result.status === 'error') throw new ProjectSetupFailed(result.error.code)
    return result
  }
  async function adopt(workspace: Workspace, repository?: string) {
    const workspaces = await window.api.listWorkspaces()
    setData((current) => ({ ...current, workspaces }))
    chooseWorkspace(workspace.id)
    if (repository) setRepositoryId(repository)
  }
  async function chooseFolder() {
    const folder = await window.api.pickFolder()
    if (!folder) return
    let result = await runSetup({ kind: 'open', path: folder })
    // A plain folder is fine: Git is only an implementation detail of how conversations are isolated.
    if (result.status === 'needs-initialization') result = await runSetup({ kind: 'initialize-existing', path: folder })
    if (result.status === 'success') await adopt(result.workspace)
  }
  const cloneable =
    repositories.find((r) => r.id === repositoryId && r.cloneUrl) ?? repositories.find((r) => r.cloneUrl)
  async function cloneRepository() {
    if (!cloneable?.cloneUrl) return
    const parent = await window.api.pickFolder()
    if (!parent) return
    const result = await runSetup({
      kind: 'clone',
      parentPath: parent,
      name: suggestProjectName(cloneable.cloneUrl) || cloneable.name,
      remoteUrl: cloneable.cloneUrl,
      ...(cloneable.baseBranch ? { defaultBranch: cloneable.baseBranch } : {}),
    })
    if (result.status === 'success') await adopt(result.workspace, cloneable.id)
  }
  function submit() {
    if (blocker) {
      // Explain exactly what is missing and move the person to that step instead of a dead button.
      setError(blockerText[blocker])
      if (blocker === 'folder' || blocker === 'occupied') pickFolderRef.current?.focus()
      else if (blocker === 'project') document.getElementById(`${id}-project`)?.focus()
      else if (blocker === 'repository') document.getElementById(`${id}-repo`)?.focus()
      return
    }
    void act('save', save)
  }
  async function save() {
    if (!connection || !project) return
    await window.api.platformSetProjectBinding({
      workspaceId,
      connectionId: connection.id,
      organizationId: project.organizationId,
      projectId,
      boardId: project.boards[0].id,
      ...(repositoryId !== WITHOUT_CODE ? { repositoryBindingId: repositoryId } : {}),
    })
    const bindings = await window.api.platformListProjectBindings()
    setData((current) => ({ ...current, bindings }))
    setRemoved(null)
    setEditing(false)
    setNotice('saved')
  }
  function stopEditing() {
    setEditing(false)
    setError('')
    setFolderError('')
    setNotice('')
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-5 rounded-xl border border-border p-5"
      data-testid="project-binding-section"
    >
      <header className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <h3 id={`${id}-title`} className="text-sm font-semibold">
            {L('Projects on this computer', 'Projetos neste computador')}
          </h3>
          <Button variant="ghost" size="sm" disabled={loading || !!busy} onClick={() => setRevision((n) => n + 1)}>
            {L('Refresh', 'Atualizar')}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {L(
            'Tell this computer which local folder belongs to each Kanban project. Cards of that project can then run here.',
            'Diga a este computador qual pasta local corresponde a cada projeto do Kanban. Os cards desse projeto poderão rodar aqui.'
          )}
        </p>
      </header>
      {connections.filter((c) => c.state === 'connected').length > 1 ? (
        <div className="space-y-2">
          <label className="text-xs font-medium" htmlFor={`${id}-connection`}>
            {L('Kanban instance', 'Instância do Kanban')}
          </label>
          <Select value={connection.id} onValueChange={setConnectionId} disabled={!!busy}>
            <SelectTrigger className="min-w-0 [&>span]:min-w-0 [&>span]:truncate" id={`${id}-connection`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {connections
                .filter((c) => c.state === 'connected')
                .map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {c.url}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {L('Loading projects…', 'Carregando projetos…')}
        </p>
      ) : loadError ? (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {L(
              'Could not load projects. Check the Kanban connection and try again.',
              'Não foi possível carregar os projetos. Verifique a conexão com o Kanban e tente novamente.'
            )}
          </p>
          <Button variant="outline" size="sm" onClick={() => setRevision((n) => n + 1)}>
            {L('Try again', 'Tentar novamente')}
          </Button>
        </div>
      ) : !data.projects.length ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {L(
              'No projects are available for this account. Create a project in the Kanban or ask for access, then refresh this list.',
              'Nenhum projeto está disponível para esta conta. Crie um projeto no Kanban ou peça acesso e atualize esta lista.'
            )}
          </p>
          <Button variant="outline" size="sm" onClick={() => setRevision((n) => n + 1)}>
            {L('Refresh projects', 'Atualizar projetos')}
          </Button>
        </div>
      ) : (
        <>
          {editing || !linked.length ? (
            <>
              <fieldset disabled={!!busy} className="min-w-0 space-y-5">
                <Step
                  number={1}
                  done={!!project}
                  label={L('Kanban project', 'Projeto do Kanban')}
                  htmlFor={`${id}-project`}
                >
                  <Select value={projectId} onValueChange={chooseProject}>
                    <SelectTrigger className="min-w-0 [&>span]:min-w-0 [&>span]:truncate" id={`${id}-project`}>
                      <SelectValue placeholder={L('Select a project…', 'Selecione um projeto…')} />
                    </SelectTrigger>
                    <SelectContent>
                      {data.projects.map((p) => (
                        <SelectItem key={p.projectId} value={p.projectId}>
                          {p.projectName} · {p.organizationName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {project && !repositories.length ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {L(
                        'No code repository is registered for this project in the Kanban, so it will run analysis tasks only.',
                        'Este projeto não tem repositório de código cadastrado no Kanban, então rodará apenas tarefas de análise.'
                      )}
                    </p>
                  ) : null}
                </Step>
                <Step
                  number={2}
                  done={!!workspace && !occupied}
                  label={L('Folder on this computer', 'Pasta neste computador')}
                  htmlFor={data.workspaces.length ? `${id}-folder` : undefined}
                >
                  {data.workspaces.length ? (
                    <Select value={workspaceId} onValueChange={chooseWorkspace}>
                      <SelectTrigger className="min-w-0 [&>span]:min-w-0 [&>span]:truncate" id={`${id}-folder`}>
                        <SelectValue placeholder={L('Select a local folder…', 'Selecione uma pasta local…')}>
                          {workspace?.name}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {data.workspaces.map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            <span className="block text-xs">{w.name}</span>
                            <span className="block max-w-[min(28rem,calc(100vw-3rem))] break-all whitespace-normal text-[11px] text-muted-foreground">
                              {w.path}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {workspace ? (
                    <p className="break-all font-mono text-xs leading-relaxed text-muted-foreground" translate="no">
                      {workspace.path}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      ref={pickFolderRef}
                      id={`${id}-pick-folder`}
                      variant={workspace ? 'outline' : 'default'}
                      size="sm"
                      onClick={() => void act('folder', chooseFolder)}
                    >
                      {busy === 'folder' ? (
                        <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      ) : (
                        <FolderOpen size={14} aria-hidden="true" />
                      )}
                      {L(
                        workspace ? 'Choose another folder…' : 'Choose folder…',
                        workspace ? 'Escolher outra pasta…' : 'Escolher pasta…'
                      )}
                    </Button>
                    {cloneable && !workspace ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void act('clone', cloneRepository)}
                        title={cloneable.cloneUrl}
                      >
                        {busy === 'clone' ? (
                          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        ) : (
                          <CloudDownload size={14} aria-hidden="true" />
                        )}
                        {L(`Clone ${cloneable.name}…`, `Clonar ${cloneable.name}…`)}
                      </Button>
                    ) : null}
                  </div>
                  {phase ? (
                    <p role="status" className="text-xs text-muted-foreground" data-testid="folder-progress">
                      {t(`projectSetup.phases.${phase.phase}`)}
                      {phase.percent !== undefined ? ` ${phase.percent}%` : ''}
                    </p>
                  ) : !workspace && !folderError ? (
                    <p className="text-xs text-muted-foreground">
                      {cloneable
                        ? L(
                            'Pick an existing folder, or clone the project repository into a new one.',
                            'Escolha uma pasta existente ou clone o repositório do projeto em uma nova.'
                          )
                        : L(
                            'Any folder works. If it is not a Git repository yet, one is initialized for you.',
                            'Qualquer pasta serve. Se ainda não for um repositório Git, ele é iniciado para você.'
                          )}
                    </p>
                  ) : null}
                  {folderError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {folderError}
                    </p>
                  ) : occupied ? (
                    <p role="alert" className="text-xs text-destructive">
                      {blockerText.occupied}
                    </p>
                  ) : null}
                </Step>
                {repositories.length ? (
                  <Step
                    number={3}
                    done={!!repositoryId}
                    label={L('Code repository', 'Repositório do código')}
                    htmlFor={`${id}-repo`}
                  >
                    <Select
                      value={repositoryId}
                      onValueChange={(value) => {
                        setRepositoryId(value)
                        setNotice('')
                        setError('')
                      }}
                    >
                      <SelectTrigger className="min-w-0 [&>span]:min-w-0 [&>span]:truncate" id={`${id}-repo`}>
                        <SelectValue placeholder={L('Select a repository…', 'Selecione um repositório…')} />
                      </SelectTrigger>
                      <SelectContent>
                        {repositories.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                            {r.baseBranch ? ` · ${r.baseBranch}` : ''}
                          </SelectItem>
                        ))}
                        <SelectItem value={WITHOUT_CODE}>{L('Tasks without code', 'Tarefas sem código')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {repositoryId === WITHOUT_CODE
                        ? L('Tasks run without repository code.', 'As tarefas rodam sem o código do repositório.')
                        : L(
                            'The folder in step 2 must contain this repository.',
                            'A pasta do passo 2 precisa conter esse repositório.'
                          )}
                    </p>
                  </Step>
                ) : null}
              </fieldset>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={!!busy} onClick={submit}>
                    {busy === 'save' ? (
                      <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    ) : (
                      <Link2 size={14} aria-hidden="true" />
                    )}
                    {L(
                      existing && !occupied ? 'Update link' : 'Link project',
                      existing && !occupied ? 'Atualizar vínculo' : 'Vincular projeto'
                    )}
                  </Button>
                  {linked.length ? (
                    <Button variant="ghost" disabled={!!busy} onClick={stopEditing}>
                      {L('Cancel', 'Cancelar')}
                    </Button>
                  ) : null}
                </div>
                {error ? (
                  <p role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                ) : blocker && blocker !== 'occupied' ? (
                  <p className="text-xs text-muted-foreground" data-testid="link-blocker">
                    {L('Missing: ', 'Falta: ')}
                    {blockerText[blocker].replace(/^./, (c) => c.toLowerCase())}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {L(
                      'Ready. Linking only saves this pairing; nothing runs yet.',
                      'Tudo pronto. Vincular só salva essa relação; nada roda ainda.'
                    )}
                  </p>
                )}
              </div>
            </>
          ) : null}
          {notice ? (
            <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
              {L(
                'Project linked. You can now start the executor below.',
                'Projeto vinculado. Agora você pode iniciar o executor abaixo.'
              )}
            </p>
          ) : null}
          {linked.length ? (
            <div className={editing ? 'space-y-3 border-t border-border pt-4' : 'space-y-3'}>
              <h4 className="text-xs font-medium">{L('Linked projects', 'Projetos vinculados')}</h4>
              {linked.map((b) => {
                const p = data.projects.find((p) => p.projectId === b.projectId),
                  w = data.workspaces.find((w) => w.id === b.workspaceId)
                return (
                  <article
                    key={b.workspaceId}
                    className="flex flex-wrap items-start gap-3"
                    data-testid="saved-project-binding"
                  >
                    <Check size={15} className="mt-0.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="break-words text-xs font-medium">
                        {p?.projectName ?? L('Linked project', 'Projeto vinculado')}
                      </p>
                      <p className="break-all font-mono text-[11px] text-muted-foreground" translate="no">
                        {w?.path ?? L('Local folder unavailable', 'Pasta local indisponível')}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {b.repositoryBindingId
                          ? (p?.repositories?.find((r) => r.id === b.repositoryBindingId)?.name ??
                            L('Code repository', 'Repositório de código'))
                          : L('Tasks without code', 'Tarefas sem código')}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!busy}
                      onClick={() =>
                        void act('remove', async () => {
                          await window.api.platformRemoveProjectBinding(b.workspaceId)
                          setData((current) => ({
                            ...current,
                            bindings: current.bindings.filter((item) => item.workspaceId !== b.workspaceId),
                          }))
                          setRemoved(b)
                        })
                      }
                    >
                      {L('Remove link', 'Remover vínculo')}
                    </Button>
                  </article>
                )
              })}
            </div>
          ) : null}
          {linked.length && !editing ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(true)
                setWorkspaceId('')
                setNotice('')
                setError('')
                setFolderError('')
              }}
            >
              <Link2 size={14} aria-hidden="true" />
              {L('Link another project', 'Vincular outro projeto')}
            </Button>
          ) : null}
          {error && !editing && linked.length ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {removed ? (
            <div role="status" className="flex flex-wrap items-center gap-2 text-xs">
              <span>
                {L(
                  'Link removed. Your folder and conversations are preserved.',
                  'Vínculo removido. Sua pasta e suas conversas foram preservadas.'
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() =>
                  void act('save', async () => {
                    await window.api.platformSetProjectBinding(removed)
                    setData((current) => ({
                      ...current,
                      bindings: [...current.bindings.filter((b) => b.workspaceId !== removed.workspaceId), removed],
                    }))
                    setRemoved(null)
                  })
                }
              >
                {L('Undo', 'Desfazer')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
