import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, CircleSlash, Pause, Play, RefreshCw, Sparkles } from 'lucide-react'
import type {
  DelegationEvent,
  DelegationExecutor,
  DelegationTask,
  DelegationTaskView,
} from '@maestrly/protocol'
import { delegations } from '../../app/api.js'
import { t, useLocale, errorText, dateTime } from '../../i18n/index.js'
import { FormDialog } from '../../components/FormDialog.js'
import { Select } from '../../components/Select.js'
import { EmptyState } from '../../components/EmptyState.js'
import { ModelPicker, defaultChoice, type ModelChoice } from './ModelPicker.js'

const stateText: Record<DelegationTask['state'], string> = {
  draft: 'Draft',
  queued: 'Queued',
  running: 'Running',
  pausing: 'Pausing',
  paused: 'Paused',
  waiting_input: 'Waiting for you',
  waiting_review: 'Waiting for review',
  watching: 'Watching the pull request',
  needs_attention: 'Needs a decision',
  completed: 'Completed',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
  failed: 'Failed',
}

const blockerText: Record<string, string> = {
  executor_offline: 'The executor is offline.',
  selection_unavailable: 'The chosen account and model are no longer available.',
  catalog_changed: 'The executor inventory changed.',
  permission_lost: 'The task owner lost permission in this project.',
  awaiting_human_decision: 'This task is waiting for a decision.',
  awaiting_information: 'This task is waiting for something else to finish.',
  review_findings_open: 'Review findings are still open.',
  check_setup_incomplete: 'A required check did not pass on this revision.',
  executor_error: 'A stage failed on the executor.',
}

function TaskDetail({
  organizationId,
  projectId,
  taskId,
  executors,
  onChanged,
  onClose,
}: {
  organizationId: string
  projectId: string
  taskId: string
  executors: DelegationExecutor[]
  onChanged(): void
  onClose(): void
}) {
  useLocale()
  const [view, setView] = useState<DelegationTaskView | null>(null)
  const [events, setEvents] = useState<DelegationEvent[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [configuring, setConfiguring] = useState<{ stageId: string | null; choice: ModelChoice } | null>(null)

  const catalog = useMemo(
    () => executors.find((executor) => executor.executorId === view?.task.executorId)?.catalog ?? null,
    [executors, view]
  )

  const load = useCallback(async () => {
    try {
      const value = await delegations.get(organizationId, projectId, taskId)
      setView(value)
      setEvents(await delegations.events(organizationId, projectId, taskId))
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load this task.')
    }
  }, [organizationId, projectId, taskId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [load])

  async function control(action: 'start' | 'pause' | 'resume' | 'cancel') {
    if (!view || busy) return
    setBusy(true)
    setError('')
    try {
      await delegations.command(
        organizationId,
        projectId,
        taskId,
        action === 'pause'
          ? { type: 'pause', expectedVersion: view.task.version, immediate: false }
          : action === 'cancel'
            ? { type: 'cancel', expectedVersion: view.task.version, reason: '' }
            : { type: action, expectedVersion: view.task.version },
        crypto.randomUUID()
      )
      await load()
      onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not apply that command.')
    } finally {
      setBusy(false)
    }
  }

  const task = view?.task
  return (
    <section className="delegation-detail">
      <header>
        <div>
          <p className="eyebrow">{t('Delegated task')}</p>
          <h3>{task?.title ?? t('Loading…')}</h3>
          {task ? <p className="state-chip">{t(stateText[task.state])}</p> : null}
        </div>
        <button className="quiet" onClick={onClose}>
          {t('Close')}
        </button>
      </header>
      {error ? (
        <p role="alert" className="form-error">
          {errorText(error)}
        </p>
      ) : null}
      {task?.blocker ? (
        <p className="form-note delegation-blocker">
          <CircleSlash size={15} /> {t(blockerText[task.blocker.reason] ?? task.blocker.reason)}{' '}
          {task.blocker.detail}
        </p>
      ) : null}
      {task ? (
        <div className="delegation-controls">
          <button className="quiet" disabled={busy || task.state !== 'draft'} onClick={() => void control('start')}>
            <Play size={15} /> {t('Start')}
          </button>
          <button
            className="quiet"
            disabled={busy || !['queued', 'running', 'waiting_review'].includes(task.state)}
            onClick={() => void control('pause')}
          >
            <Pause size={15} /> {t('Pause')}
          </button>
          <button
            className="quiet"
            disabled={busy || !['paused', 'pausing', 'needs_attention', 'watching'].includes(task.state)}
            onClick={() => void control('resume')}
          >
            <RefreshCw size={15} /> {t('Resume')}
          </button>
          <button
            className="quiet"
            disabled={busy || ['completed', 'cancelled', 'failed'].includes(task.state)}
            onClick={() => void control('cancel')}
          >
            <CircleSlash size={15} /> {t('Cancel')}
          </button>
        </div>
      ) : null}
      <ol className="delegation-stages">
        {view?.stages.map((stage) => {
          const model = stage.settings
            ? catalog?.models.find((entry) => entry.selectionId === stage.settings?.selectionId)
            : null
          return (
            <li key={stage.id}>
              <div>
                <strong>{stage.title}</strong>
                <span className="state-chip">{stage.type}</span>
                <span className="state-chip">{stage.state}</span>
              </div>
              {stage.settings ? (
                <p className="form-note">
                  {model ? `${model.accountLabel} · ${model.modelLabel}` : t('This selection is no longer available.')}
                  {stage.settings.reasoning ? ` · ${stage.settings.reasoning}` : ''}
                  {stage.settings.fastMode ? ` · ${t('Fast mode')}` : ''}
                  {stage.settings.executionMode === 'maestro' ? ` · ${t('Maestro')}` : ''}
                </p>
              ) : stage.action ? (
                <p className="form-note">{stage.action.kind}</p>
              ) : null}
              {stage.settings && catalog ? (
                <button
                  className="quiet"
                  disabled={!catalog.models.length}
                  onClick={() =>
                    setConfiguring({ stageId: stage.id, choice: defaultChoice(catalog, stage.settings) })
                  }
                >
                  {t('Change model')}
                </button>
              ) : null}
            </li>
          )
        })}
      </ol>
      <h4>{t('Timeline')}</h4>
      <ol className="delegation-events">
        {events
          .slice(-40)
          .reverse()
          .map((event) => (
            <li key={event.id}>
              <span className="form-note">{dateTime(event.createdAt)}</span>
              <span>{event.type}</span>
            </li>
          ))}
      </ol>
      {configuring && catalog && view ? (
        <FormDialog
          title={t('Change model')}
          submitLabel={t('Apply to this stage')}
          onClose={() => setConfiguring(null)}
          onSubmit={async () => {
            await delegations.command(
              organizationId,
              projectId,
              taskId,
              {
                type: 'configure',
                expectedVersion: view.task.version,
                target: 'stage',
                stageId: configuring.stageId ?? undefined,
                settingsPatch: {
                  selectionId: configuring.choice.selectionId,
                  reasoning: configuring.choice.reasoning,
                  fastMode: configuring.choice.fastMode,
                  executionMode: configuring.choice.executionMode,
                  delegationProfiles: configuring.choice.delegationProfiles,
                },
                apply: 'after_current',
              },
              crypto.randomUUID()
            )
            await load()
            onChanged()
          }}
        >
          <ModelPicker
            catalog={catalog}
            value={configuring.choice}
            onChange={(choice) => setConfiguring({ ...configuring, choice })}
          />
          <p className="form-note">
            {t('The change applies to the next attempt; the attempt already running finishes first.')}
          </p>
        </FormDialog>
      ) : null}
    </section>
  )
}

export function DelegationsPanel({
  organizationId,
  projectId,
  boardId,
}: {
  organizationId: string
  projectId: string
  boardId: string
}) {
  useLocale()
  const [items, setItems] = useState<Array<{ task: DelegationTask; links: { task: string; card: string } }>>([])
  const [executors, setExecutors] = useState<DelegationExecutor[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [openTaskId, setOpenTaskId] = useState('')
  const [creating, setCreating] = useState(false)
  const [choice, setChoice] = useState<ModelChoice | null>(null)
  const [executorId, setExecutorId] = useState('')
  const [workspaceKey, setWorkspaceKey] = useState('')
  const [baseBranch, setBaseBranch] = useState('')

  const load = useCallback(async () => {
    if (!organizationId || !projectId) return
    try {
      const [list, catalog] = await Promise.all([
        delegations.list(organizationId, projectId, { limit: 50 }),
        delegations.catalog(organizationId, projectId),
      ])
      setItems(list.items)
      setExecutors(catalog)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load delegations.')
    } finally {
      setLoading(false)
    }
  }, [organizationId, projectId])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 10000)
    return () => clearInterval(timer)
  }, [load])

  const executor = executors.find((candidate) => candidate.executorId === executorId) ?? executors[0] ?? null
  const workspaces = executor?.catalog.workspaces ?? []
  const workspace = workspaces.find((candidate) => candidate.key === workspaceKey) ?? workspaces[0] ?? null

  function startCreating() {
    const first = executors.find((candidate) => candidate.online && candidate.catalog.enabled) ?? executors[0] ?? null
    setExecutorId(first?.executorId ?? '')
    setWorkspaceKey(first?.catalog.workspaces[0]?.key ?? '')
    setBaseBranch(first?.catalog.workspaces[0]?.branches[0] ?? '')
    setChoice(first ? defaultChoice(first.catalog) : null)
    setCreating(true)
  }

  return (
    <section className="settings-panel delegations">
      <header>
        <Bot />
        <div>
          <p className="eyebrow">{t('Delegated development')}</p>
          <h2>{t('Delegations')}</h2>
        </div>
      </header>
      <p className="form-note">
        <Sparkles size={15} />{' '}
        {t('Each stage runs with the account, model and effort you choose, on a computer you connected.')}
      </p>
      <div className="personal-toolbar">
        <button className="primary" disabled={!executors.length || !boardId} onClick={startCreating}>
          {t('Delegate work')}
        </button>
        <button className="quiet" onClick={() => void load()}>
          {t('Refresh')}
        </button>
      </div>
      {loading ? <p role="status">{t('Loading…')}</p> : null}
      {error ? (
        <p role="alert" className="form-error">
          {errorText(error)}
        </p>
      ) : null}
      {!loading && !executors.length ? (
        <p className="form-note">
          {t('No connected computer offers stage delegation yet. Open Maestrly desktop and enable the executor.')}
        </p>
      ) : null}
      <div className="delegation-list">
        {items.map((item) => (
          <article key={item.task.id} className={openTaskId === item.task.id ? 'open' : ''}>
            <button className="delegation-summary" onClick={() => setOpenTaskId(openTaskId === item.task.id ? '' : item.task.id)}>
              <strong>{item.task.title}</strong>
              <span className="state-chip">{t(stateText[item.task.state])}</span>
              <span className="form-note">{dateTime(item.task.updatedAt)}</span>
            </button>
            {openTaskId === item.task.id ? (
              <TaskDetail
                organizationId={organizationId}
                projectId={projectId}
                taskId={item.task.id}
                executors={executors}
                onChanged={() => void load()}
                onClose={() => setOpenTaskId('')}
              />
            ) : null}
          </article>
        ))}
      </div>
      {!loading && !items.length ? (
        <EmptyState title={t('Nothing delegated yet.')}>
          <p>{t('Describe the work, choose who does it, and follow it here.')}</p>
        </EmptyState>
      ) : null}
      {creating && executor && choice ? (
        <FormDialog
          title={t('Delegate work')}
          submitLabel={t('Delegate work')}
          submitDisabled={!choice.selectionId || !workspace}
          onClose={() => setCreating(false)}
          onSubmit={async (data) => {
            const title = String(data.get('title') ?? '').trim()
            await delegations.create(
              organizationId,
              projectId,
              {
                boardId,
                title,
                objective: String(data.get('objective') ?? ''),
                acceptanceCriteria: String(data.get('criteria') ?? '')
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
                executorId: executor.executorId,
                workspaceKey: workspace!.key,
                baseBranch: baseBranch || workspace!.branches[0]!,
                stages: [
                  {
                    type: 'implement',
                    title: t('Implement'),
                    instructions: '',
                    dependsOn: [],
                    requiredForCompletion: true,
                    settings: {
                      selectionId: choice.selectionId,
                      reasoning: choice.reasoning,
                      fastMode: choice.fastMode,
                      executionMode: choice.executionMode,
                      delegationProfiles: choice.delegationProfiles,
                    },
                  },
                ],
                dependsOnTaskIds: [],
                start: data.get('start') === 'on',
              },
              crypto.randomUUID()
            )
            await load()
          }}
        >
          <label>
            {t('What should be done')}
            <input name="title" required maxLength={500} />
          </label>
          <label>
            {t('Objective')}
            <textarea name="objective" rows={3} />
          </label>
          <label>
            {t('Acceptance criteria, one per line')}
            <textarea name="criteria" rows={3} />
          </label>
          <div className="model-picker-field">
            <span className="field-label">{t('Computer')}</span>
            <Select
              label={t('Computer')}
              value={executor.executorId}
              onChange={(next) => {
                const chosen = executors.find((candidate) => candidate.executorId === next)
                setExecutorId(next)
                setWorkspaceKey(chosen?.catalog.workspaces[0]?.key ?? '')
                setBaseBranch(chosen?.catalog.workspaces[0]?.branches[0] ?? '')
                setChoice(chosen ? defaultChoice(chosen.catalog) : null)
              }}
              options={executors.map((candidate) => ({
                value: candidate.executorId,
                label: `${candidate.name}${candidate.online ? '' : ` · ${t('Offline')}`}`,
              }))}
            />
          </div>
          <div className="model-picker-field">
            <span className="field-label">{t('Workspace')}</span>
            <Select
              label={t('Workspace')}
              disabled={!workspaces.length}
              value={workspace?.key ?? ''}
              onChange={(next) => {
                setWorkspaceKey(next)
                setBaseBranch(workspaces.find((candidate) => candidate.key === next)?.branches[0] ?? '')
              }}
              options={workspaces.map((candidate) => ({ value: candidate.key, label: candidate.label }))}
            />
          </div>
          <div className="model-picker-field">
            <span className="field-label">{t('Base branch')}</span>
            <Select
              label={t('Base branch')}
              disabled={!workspace?.branches.length}
              value={baseBranch || (workspace?.branches[0] ?? '')}
              onChange={setBaseBranch}
              options={(workspace?.branches ?? []).map((branch) => ({ value: branch, label: branch }))}
            />
          </div>
          <ModelPicker catalog={executor.catalog} value={choice} onChange={setChoice} />
          <label className="checkbox-row">
            <input type="checkbox" name="start" defaultChecked />
            <span>{t('Start right away')}</span>
          </label>
          {executor.catalog.issues.map((issue) => (
            <p className="form-note" key={issue}>
              {errorText(issue)}
            </p>
          ))}
        </FormDialog>
      ) : null}
    </section>
  )
}
