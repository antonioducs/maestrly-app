import { useEffect, useState } from 'react'
import { diffLines } from 'diff'
import {
  columnAutomationSchema,
  modelSupports,
  type ColumnAutomation,
  type Card,
  type RepositoryBinding,
} from '@maestrly/protocol'
import { api, write } from '../../app/api.js'
import { t, useLocale, errorText, dateTime } from '../../i18n/index.js'
import { Modal } from '../../components/Modal.js'
import { Select } from '../../components/Select.js'
import { Markdown } from '../../components/Markdown.js'
import { ModelFields, type CatalogRunner, catalogModels } from './ModelFields.js'
interface Loaded {
  column: { id: string; name: string; boardId: string; projectId: string; role: string }
  projectName: string
  boardName: string
  boardVersion: number
  rolesConfigured: boolean
  policyId: string | null
  version: number
  config: ColumnAutomation
}
interface Version {
  id: string
  version: number
  createdAt: string
  config: ColumnAutomation
}
export function AutomationEditor({
  organizationId,
  columnId,
  onClose,
  onSaved,
}: {
  organizationId: string
  columnId: string
  onClose(): void
  onSaved(): void
}) {
  useLocale()
  const [loaded, setLoaded] = useState<Loaded | null>(null),
    [config, setConfig] = useState<ColumnAutomation>(columnAutomationSchema.parse({}))
  const [runners, setRunners] = useState<CatalogRunner[]>([]),
    [repos, setRepos] = useState<RepositoryBinding[]>([]),
    [cards, setCards] = useState<Card[]>([])
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [saved, setSaved] = useState(false)
  const [expanded, setExpanded] = useState(false),
    [history, setHistory] = useState<Version[] | null>(null),
    [chosen, setChosen] = useState<Version | null>(null)
  const [conflict, setConflict] = useState<Loaded | null>(null)
  const [previewCard, setPreviewCard] = useState(''),
    [preview, setPreview] = useState<string | null>(null)
  const base = `/api/v1/organizations/${organizationId}/columns/${columnId}/automation`
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const data = await api<Loaded>(base)
        const [catalog, repoList, board] = await Promise.all([
          api<{ runners: CatalogRunner[] }>(
            `/api/v1/organizations/${organizationId}/projects/${data.column.projectId}/automation-catalog`
          ),
          api<RepositoryBinding[]>(
            `/api/v1/organizations/${organizationId}/projects/${data.column.projectId}/repositories`
          ),
          api<{ cards: Card[] }>(`/api/v1/organizations/${organizationId}/boards/${data.column.boardId}`),
        ])
        if (active) {
          setLoaded(data)
          setConfig(columnAutomationSchema.parse(data.config))
          setRunners(catalog.runners)
          setRepos(repoList)
          setCards(board.cards)
          setPreviewCard(board.cards[0]?.id ?? '')
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load automation.')
      }
    })()
    return () => {
      active = false
    }
  }, [base, organizationId])
  function update(patch: Partial<ColumnAutomation>) {
    setConfig((current) => ({ ...current, ...patch }))
    setDirty(true)
    setSaved(false)
  }
  async function operation(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save policy.')
      if (caught instanceof Error && caught.message === 'The column configuration changed. Reload before saving.') {
        try {
          setConflict(await api<Loaded>(base))
        } catch {
          /* Keep the current draft if reloading fails. */
        }
      }
    } finally {
      setBusy(false)
    }
  }
  const selectedRunners = runners.filter((r) => config.runnerSelector !== 'runner' || r.id === config.targetRunnerId)
  const models = catalogModels(runners, config.runnerSelector === 'runner' ? config.targetRunnerId : null)
  const modelValid = models.some((m) => modelSupports(config, m))
  const canAutoRun = catalogModels(runners.filter(r=>!r.personal),config.runnerSelector==='runner'?config.targetRunnerId:null).some(m=>modelSupports(config,m))
  const canMaestro = selectedRunners.some((r) => r.capabilities?.maestro)
  const canSubagents = selectedRunners.some((r) => r.capabilities?.subagents)
  const canCommands = selectedRunners.some((r) => r.capabilities?.preCommands)
  const normal = loaded?.column.role === 'normal'
  return (
    <Modal
      closeLabel={t('Close dialog')}
      title={loaded ? t('Automation') + ' · ' + loaded.column.name : t('Loading automation…')}
      onClose={onClose}
      wide
    >
      {loaded ? (
        <p className="page-project-context">
          {t('Project')}: <strong>{loaded.projectName}</strong> · {t('Board')}: {loaded.boardName} · {t('Column')}:{' '}
          {loaded.column.name}
        </p>
      ) : null}
      {!loaded && !error ? <p>{t('Loading automation…')}</p> : null}
      {loaded ? (
        <>
          <div className="automation-status-row">
            <span>
              {t('Version')} {loaded.version}
            </span>
            <button
              className="quiet"
              disabled={busy}
              onClick={() =>
                void operation(async () => {
                  const data = await api<{ runners: CatalogRunner[] }>(
                    `/api/v1/organizations/${organizationId}/projects/${loaded.column.projectId}/automation-catalog`
                  )
                  setRunners(data.runners)
                })
              }
            >
              {t('Refresh runners')}
            </button>
            <span>{t(dirty ? 'Unsaved changes' : saved ? 'Changes saved.' : 'Saved configuration')}</span>
            <button
              className="quiet"
              disabled={busy}
              onClick={() => void operation(async () => setHistory(await api<Version[]>(base + '/history')))}
            >
              {t('Configuration history')}
            </button>
          </div>
          {!normal ? <p className="form-note">{t('Fixed columns cannot run automations.')}</p> : null}
          <fieldset className="automation-fields" disabled={busy || !normal}>
            <div className="automation-toggle-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  disabled={!config.enabled && !modelValid}
                  onChange={(e) => update({ enabled: e.target.checked })}
                />
                {t('Agent enabled')}
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={config.autoRun}
                  disabled={!config.enabled||!canAutoRun}
                  onChange={(e) => update({ autoRun: e.target.checked })}
                />
                {t('Run automatically on entry')}
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={config.provider !== 'maestrly' && config.approvalRequired}
                  disabled={config.provider === 'maestrly'}
                  onChange={(e) => update({ approvalRequired: e.target.checked })}
                />
                {t('Require approval before claim')}
              </label>
            </div>
            <p className="form-note">
              {t('An enabled agent can run manually. Automatic entry is a separate setting.')}
            </p>
            <div className="policy-grid">
              <div className="select-field">
                {t('Execution destination')}
                <Select
                  label={t('Execution destination')}
                  value={config.runnerSelector}
                  onChange={(value) => update({ runnerSelector: value as 'pool' | 'runner', targetRunnerId: null })}
                  options={[
                    { value: 'pool', label: t('Compatible runner pool') },
                    { value: 'runner', label: t('Specific runner') },
                  ]}
                />
              </div>
              {config.runnerSelector === 'runner' ? (
                <div className="select-field">
                  {t('Runner')}
                  <Select
                    label={t('Runner')}
                    value={config.targetRunnerId ?? ''}
                    onChange={(targetRunnerId) => update({ targetRunnerId: targetRunnerId || null })}
                    options={[
                      { value: '', label: t('Select a runner') },
                      ...runners.filter(r=>!r.personal).map((r) => ({ value: r.id, label: r.name + ' · ' + t(r.status) })),
                    ]}
                  />
                </div>
              ) : null}
              <ModelFields config={config} update={update} runners={runners} disabled={busy} />
              {modelValid&&!canAutoRun?<p className="form-note automation-wide">{t('This model is available on your personal computer. Use Run on my computer on the card.')}</p>:null}
              <div className="select-field">
                {t('Execution mode')}
                <Select
                  label={t('Execution mode')}
                  value={config.mode}
                  onChange={(mode) =>
                    update({
                      mode: mode as 'standard' | 'maestro',
                      ...(mode === 'maestro' ? { subagentsEnabled: true } : {}),
                    })
                  }
                  options={[
                    { value: 'standard', label: t('Standard') },
                    ...(canMaestro || config.mode === 'maestro' ? [{ value: 'maestro', label: 'Maestro' }] : []),
                  ]}
                />
              </div>
              {config.mode === 'maestro' ? (
                <div className="select-field">
                  {t('Maestro strategy')}
                  <Select
                    label={t('Maestro strategy')}
                    value={config.maestroStrategy}
                    onChange={(maestroStrategy) =>
                      update({ maestroStrategy: maestroStrategy as ColumnAutomation['maestroStrategy'] })
                    }
                    options={['balanced', 'best-quality', 'fast', 'economy'].map((value) => ({
                      value,
                      label: t(value),
                    }))}
                  />
                </div>
              ) : null}
              {canSubagents || config.subagentsEnabled ? (
                <label className="check">
                  <input
                    type="checkbox"
                    disabled={!canSubagents || config.mode === 'maestro'}
                    checked={config.subagentsEnabled}
                    onChange={(e) => update({ subagentsEnabled: e.target.checked })}
                  />
                  {t('Allow Maestrly subagents')}
                </label>
              ) : null}
              <div className="select-field">
                {t('Task type')}
                <Select
                  label={t('Task type')}
                  value={config.taskType}
                  onChange={(taskType) => update({ taskType: taskType as 'code' | 'analysis' })}
                  options={[
                    { value: 'code', label: t('Code') },
                    { value: 'analysis', label: t('Repository-free analysis') },
                  ]}
                />
              </div>
              <div className="select-field">
                {t('Repository')}
                <Select
                  disabled={config.taskType === 'analysis'}
                  label={t('Repository')}
                  value={config.repositoryBindingId ?? ''}
                  onChange={(id) => update({ repositoryBindingId: id || null })}
                  options={[
                    { value: '', label: t('Inherit project repository') },
                    ...repos.filter((r) => !r.disabledAt).map((r) => ({ value: r.id, label: r.name })),
                  ]}
                />
              </div>
              <label>
                {t('Branch override (optional)')}
                <input
                  disabled={config.taskType === 'analysis'}
                  value={config.repositoryBranch ?? ''}
                  onChange={(e) => update({ repositoryBranch: e.target.value || null })}
                  placeholder={t('Inherit repository base branch')}
                />
              </label>
            </div>
            <section className="card-section">
              <header>
                <h3>{t('Initialization prompt')}</h3>
                <button type="button" className="quiet" onClick={() => setExpanded(true)}>
                  {t('Expand prompt')}
                </button>
              </header>
              <p className="form-note">
                {t('Available prompt variables')}: <code>{'{task_number} {task_title} {task_body} {column_name}'}</code>
              </p>
              <textarea
                aria-label={t('Initialization prompt')}
                value={config.promptTemplate}
                rows={7}
                maxLength={100000}
                placeholder={t('Leave empty to use the default task prompt.')}
                onChange={(e) => update({ promptTemplate: e.target.value })}
              />
              <div className="prompt-preview-controls">
                <Select
                  label={t('Preview card')}
                  value={previewCard}
                  onChange={setPreviewCard}
                  options={cards.map((card) => ({ value: card.id, label: card.id.slice(0, 8) + ' · ' + card.title }))}
                />
                <button
                  type="button"
                  className="quiet"
                  disabled={!previewCard || busy}
                  onClick={() =>
                    void operation(async () => {
                      const result = await write<{ prompt: string }>(base + '/preview', 'POST', {
                        cardId: previewCard,
                        promptTemplate: config.promptTemplate,
                      })
                      setPreview(result.prompt)
                    })
                  }
                >
                  {t('Preview prompt')}
                </button>
              </div>
            </section>
            <section className="card-section">
              <h3>{t('Pre-commands')}</h3>
              <p className="form-note">
                {t(
                  'One command per line. Commands run in the approved isolated image, without host credentials or network. Failure stops agent startup.'
                )}
              </p>
              <textarea
                aria-label={t('Pre-commands')}
                disabled={!canCommands || config.taskType === 'analysis'}
                value={config.preCommands.join('\n')}
                rows={3}
                onChange={(e) => update({ preCommands: e.target.value.split('\n') })}
              />
              {!canCommands ? (
                <p className="form-note">
                  {t('No runner has an approved command sandbox image. Configure it on the runner and restart.')}
                </p>
              ) : null}
            </section>
            <section className="card-section">
              <h3>{t('Execution limits')}</h3>
              <div className="policy-grid">
                <label>
                  {t('Timeout (seconds)')}
                  <input
                    type="number"
                    min={1}
                    max={86400}
                    value={config.maxDurationSeconds ?? ''}
                    placeholder={t('Inherit board limit')}
                    onChange={(e) => update({ maxDurationSeconds: e.target.value ? Number(e.target.value) : null })}
                  />
                </label>
                <label>
                  {t('Log limit (bytes)')}
                  <input
                    type="number"
                    min={1}
                    max={10485760}
                    value={config.maxLogBytes ?? ''}
                    placeholder={t('Inherit board limit')}
                    onChange={(e) => update({ maxLogBytes: e.target.value ? Number(e.target.value) : null })}
                  />
                </label>
              </div>
            </section>
          </fieldset>
          {config.enabled && !modelValid ? (
            <p className="form-error">
              {t('Select a supported provider, model and effort before enabling this column.')}
            </p>
          ) : null}
          {selectedRunners.flatMap((r) =>
            (r.capabilities?.issues ?? []).map((issue) => (
              <p className="form-note" key={r.id + issue}>
                {r.name}: {t(issue)}
              </p>
            ))
          )}
          <p className="form-note">{t('Changes affect future jobs. Existing execution snapshots are preserved.')}</p>
          <div className="dialog-actions">
            <button className="quiet" onClick={onClose}>
              {t('Close')}
            </button>
            <button
              className="primary"
              disabled={busy || !normal || (config.enabled && !modelValid)}
              onClick={() =>
                void operation(async () => {
                  const clean = columnAutomationSchema.parse({
                    ...config,
                    preCommands: config.preCommands.map((c) => c.trim()).filter(Boolean),
                  })
                  const result = await write<{ policyId: string; version: number; config: ColumnAutomation }>(
                    base,
                    'PUT',
                    { expectedPolicyId: loaded.policyId, config: clean }
                  )
                  setLoaded({ ...loaded, ...result })
                  setConfig(result.config)
                  setDirty(false)
                  setSaved(true)
                  onSaved()
                })
              }
            >
              {t(busy ? 'Saving…' : 'Save automation')}
            </button>
          </div>
        </>
      ) : null}
      {conflict ? (
        <div className="conflict-box">
          <p>{t('The saved configuration changed. Compare it with your draft before saving again.')}</p>
          <div className="markdown-diff">
            {diffLines(JSON.stringify(conflict.config, null, 2), JSON.stringify(config, null, 2)).map((part, index) => (
              <pre key={index} className={part.added ? 'added' : part.removed ? 'removed' : ''}>
                {part.value}
              </pre>
            ))}
          </div>
          <button
            className="quiet"
            onClick={() => {
              setLoaded(conflict)
              setConfig(conflict.config)
              setConflict(null)
              setDirty(false)
              setError('')
            }}
          >
            {t('Use saved configuration')}
          </button>
          <button
            className="primary"
            onClick={() => {
              setLoaded(conflict)
              setConflict(null)
              setDirty(true)
              setError('')
            }}
          >
            {t('Keep my draft')}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      {saved ? (
        <p className="success-message" role="status">
          {t('Automation saved for this column.')}
        </p>
      ) : null}
      {expanded ? (
        <Modal
          closeLabel={t('Close dialog')}
          title={t('Initialization prompt')}
          onClose={() => setExpanded(false)}
          wide
        >
          <textarea
            aria-label={t('Expanded prompt')}
            rows={18}
            value={config.promptTemplate}
            maxLength={100000}
            onChange={(e) => update({ promptTemplate: e.target.value })}
          />
          <button className="quiet" onClick={() => setExpanded(false)}>
            {t('Back to settings')}
          </button>
        </Modal>
      ) : null}
      {preview !== null ? (
        <Modal closeLabel={t('Close dialog')} title={t('Rendered prompt')} onClose={() => setPreview(null)} wide>
          <Markdown value={preview} />
        </Modal>
      ) : null}
      {history ? (
        <Modal
          closeLabel={t('Close dialog')}
          title={t('Configuration history')}
          onClose={() => {
            setHistory(null)
            setChosen(null)
          }}
          wide
        >
          <div className="history-list">
            {history.map((version) => (
              <button key={version.id} className="quiet" onClick={() => setChosen(version)}>
                {t('Version')} {version.version} · {dateTime(version.createdAt)}
              </button>
            ))}
          </div>
          {!history.length ? <p>{t('No configuration history yet.')}</p> : null}
          {chosen ? (
            <>
              <div className="markdown-diff">
                {diffLines(JSON.stringify(config, null, 2), JSON.stringify(chosen.config, null, 2)).map(
                  (part, index) => (
                    <pre key={index} className={part.added ? 'added' : part.removed ? 'removed' : ''}>
                      {part.value}
                    </pre>
                  )
                )}
              </div>
              <div className="dialog-actions">
                <button
                  className="quiet"
                  onClick={() => {
                    setConfig(chosen.config)
                    setDirty(true)
                    setHistory(null)
                    setChosen(null)
                  }}
                >
                  {t('Use as draft')}
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void operation(async () => {
                      const result = await write<{ policyId: string; version: number; config: ColumnAutomation }>(
                        base + '/restore',
                        'POST',
                        { expectedPolicyId: loaded!.policyId, policyId: chosen.id }
                      )
                      setLoaded({ ...loaded!, ...result })
                      setConfig(result.config)
                      setDirty(false)
                      setSaved(true)
                      setHistory(null)
                      onSaved()
                    })
                  }
                >
                  {t('Restore version')}
                </button>
              </div>
            </>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {errorText(error)}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </Modal>
  )
}
