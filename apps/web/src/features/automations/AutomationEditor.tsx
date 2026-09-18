import { useEffect, useRef, useState } from 'react'
import { diffLines } from 'diff'
import { ChevronDown } from 'lucide-react'
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
import { Field, Section } from './EditorField.js'
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
const VARIABLES = ['{task_number}', '{task_title}', '{task_body}', '{column_name}']

function OptionCard({
  id,
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string
  title: string
  description: string
  checked: boolean
  disabled: boolean
  onChange(checked: boolean): void
}) {
  return (
    <label className="af-opt">
      <input
        type="checkbox"
        aria-labelledby={id + '-title'}
        aria-describedby={id + '-desc'}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="af-opt-body">
        <strong id={id + '-title'}>{title}</strong>
        <small id={id + '-desc'}>{description}</small>
      </span>
    </label>
  )
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
  const [tall, setTall] = useState(false),
    [advanced, setAdvanced] = useState(false),
    [history, setHistory] = useState<Version[] | null>(null),
    [chosen, setChosen] = useState<Version | null>(null)
  const [conflict, setConflict] = useState<Loaded | null>(null)
  const [previewCard, setPreviewCard] = useState(''),
    [preview, setPreview] = useState<string | null>(null)
  const prompt = useRef<HTMLTextAreaElement>(null)
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
          const parsed = columnAutomationSchema.parse(data.config)
          setLoaded(data)
          setConfig(parsed)
          setAdvanced(!!(parsed.preCommands.length || parsed.maxDurationSeconds || parsed.maxLogBytes))
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
    setError('')
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
  function insertVariable(variable: string) {
    const area = prompt.current
    const start = area?.selectionStart ?? config.promptTemplate.length,
      end = area?.selectionEnd ?? start
    update({ promptTemplate: config.promptTemplate.slice(0, start) + variable + config.promptTemplate.slice(end) })
    requestAnimationFrame(() => {
      area?.focus()
      area?.setSelectionRange(start + variable.length, start + variable.length)
    })
  }
  async function loadPreview(cardId = previewCard) {
    const result = await write<{ prompt: string }>(base + '/preview', 'POST', {
      cardId,
      promptTemplate: config.promptTemplate,
    })
    setPreview(result.prompt)
  }
  const selectedRunners = runners.filter((r) => config.runnerSelector !== 'runner' || r.id === config.targetRunnerId)
  const target = runners.find((r) => r.id === config.targetRunnerId)
  const models = catalogModels(runners, config.runnerSelector === 'runner' ? config.targetRunnerId : null)
  const modelValid = models.some((m) => modelSupports(config, m))
  const canAutoRun = catalogModels(runners.filter(r=>!r.personal),config.runnerSelector==='runner'?config.targetRunnerId:null).some(m=>modelSupports(config,m))
  const canMaestro = selectedRunners.some((r) => r.capabilities?.maestro)
  const canSubagents = selectedRunners.some((r) => r.capabilities?.subagents)
  const canCommands = selectedRunners.some((r) => r.capabilities?.preCommands)
  const normal = loaded?.column.role === 'normal'
  const pool = runners.filter((r) => !r.personal)
  const issues = selectedRunners.flatMap((r) => (r.capabilities?.issues ?? []).map((issue) => r.name + ': ' + t(issue)))
  const runnerHint =
    config.runnerSelector !== 'runner'
      ? issues[0] ?? t('Any pool runner with a compatible model and repository can claim the job.')
      : !target
        ? t('Select a runner.')
        : issues[0] ?? (target.status === 'online' ? t('Online. Only this runner will claim the jobs.') : t('Offline. Jobs will wait in the queue.'))
  const runnerTone = issues.length || (config.runnerSelector === 'runner' && (!target || target.status !== 'online')) ? 'warn' : config.runnerSelector === 'runner' ? 'good' : ''
  const activationHint =
    config.provider === 'maestrly'
      ? t('The Maestrly executor applies the desktop permissions; prior approval does not apply.')
      : !config.enabled
        ? t('Saved as a draft: nothing runs until the agent is enabled.')
        : !canAutoRun
          ? t('Automatic entry requires a model available on the shared runner pool.')
          : t('An enabled agent can run manually. Automatic entry is a separate setting.')
  const statusTone = error || (config.enabled && !modelValid) ? 'error' : busy ? '' : saved ? 'ok' : dirty ? 'warn' : ''
  const statusText = error
    ? errorText(error)
    : config.enabled && !modelValid
      ? t('Select a supported provider, model and effort before enabling this column.')
      : busy
        ? t('Saving…')
        : saved
          ? t('Automation saved for this column.')
          : dirty
            ? t('Unsaved changes. They apply to future jobs; existing snapshots are preserved.')
            : t('Changes affect future jobs. Existing execution snapshots are preserved.')
  return (
    <Modal
      closeLabel={t('Close dialog')}
      title={loaded ? t('Column agent') + ' · ' + loaded.column.name : t('Loading automation…')}
      onClose={onClose}
      className="automation-dialog"
      wide
    >
      {loaded ? (
        <div className="af-topbar">
          <p className="af-crumbs">
            <span>
              {t('Project')}: <strong>{loaded.projectName}</strong>
            </span>
            <i aria-hidden="true">›</i>
            <span>{loaded.boardName}</span>
            <i aria-hidden="true">›</i>
            <span>{loaded.column.name}</span>
          </p>
          <div className="af-topbar-actions">
            <span className={'af-pill' + (dirty ? ' dirty' : '')}>
              <i className="af-dot" />
              {/* Every label is laid out in the same cell so the pill keeps its width when the state changes. */}
              <span className="af-pill-text">
                {(['Unsaved changes', 'Changes saved.', 'Saved configuration'] as const).map((key) => {
                  const current = key === (dirty ? 'Unsaved changes' : saved ? 'Changes saved.' : 'Saved configuration')
                  return (
                    <span key={key} className={current ? '' : 'af-ghost'} aria-hidden={!current}>
                      {t(key)}
                    </span>
                  )
                })}
              </span>
            </span>
            <span className="af-version">v{loaded.version}</span>
            <button
              type="button"
              className="quiet af-small"
              disabled={busy}
              onClick={() => void operation(async () => setHistory(await api<Version[]>(base + '/history')))}
            >
              {t('Configuration history')}
            </button>
            <button
              type="button"
              className="quiet af-small"
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
          </div>
        </div>
      ) : null}
      <div className="af-body">
        {!loaded && !error ? <p className="af-loading">{t('Loading automation…')}</p> : null}
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
              type="button"
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
              type="button"
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
        {loaded ? (
          <fieldset className="automation-fields" disabled={busy || !normal}>
            {!normal ? <p className="form-note">{t('Fixed columns cannot run automations.')}</p> : null}
            <Section number="01" title={t('Activation')} description={t('How and when this agent starts working.')}>
              <div className="af-options">
                <OptionCard
                  id="af-enabled"
                  title={t('Agent enabled')}
                  description={t('Allows manual runs on the cards of this column.')}
                  checked={config.enabled}
                  disabled={!config.enabled && !modelValid}
                  onChange={(enabled) => update({ enabled })}
                />
                <OptionCard
                  id="af-autorun"
                  title={t('Run automatically on entry')}
                  description={t('Dispatches when a card arrives here. Manual runs stay available.')}
                  checked={config.autoRun}
                  disabled={!config.enabled || !canAutoRun}
                  onChange={(autoRun) => update({ autoRun })}
                />
                <OptionCard
                  id="af-approval"
                  title={t('Require approval before claim')}
                  description={t('A person releases the job before a runner takes it.')}
                  checked={config.provider !== 'maestrly' && config.approvalRequired}
                  disabled={config.provider === 'maestrly'}
                  onChange={(approvalRequired) => update({ approvalRequired })}
                />
              </div>
              <p className="af-hint">{activationHint}</p>
            </Section>
            <Section number="02" title={t('Where it runs')} description={t('Runner and repository cloned into the isolated workspace.')}>
              <div className="af-grid">
                <Field
                  label={t('Execution destination')}
                  htmlFor="af-destination"
                  hint={
                    config.runnerSelector === 'pool'
                      ? t('{count} compatible runners right now.', { count: String(pool.filter((r) => r.status === 'online').length) })
                      : t('Only the chosen runner will claim the jobs.')
                  }
                >
                  <Select
                    id="af-destination"
                    label={t('Execution destination')}
                    value={config.runnerSelector}
                    onChange={(value) => update({ runnerSelector: value as 'pool' | 'runner', targetRunnerId: null })}
                    options={[
                      { value: 'pool', label: t('Compatible runner pool') },
                      { value: 'runner', label: t('Specific runner') },
                    ]}
                  />
                </Field>
                <Field label={t('Runner')} htmlFor="af-runner" hint={runnerHint} tone={runnerTone}>
                  <Select
                    id="af-runner"
                    label={t('Runner')}
                    disabled={config.runnerSelector !== 'runner'}
                    value={config.runnerSelector === 'runner' ? (config.targetRunnerId ?? '') : ''}
                    onChange={(targetRunnerId) => update({ targetRunnerId: targetRunnerId || null })}
                    options={[
                      { value: '', label: t(config.runnerSelector === 'runner' ? 'Select a runner' : 'Any compatible runner') },
                      ...pool.map((r) => ({ value: r.id, label: r.name + ' · ' + t(r.status) })),
                    ]}
                  />
                </Field>
                <Field
                  label={t('Repository')}
                  htmlFor="af-repository"
                  hint={
                    config.repositoryBindingId
                      ? t('Cloned from the local checkout into an isolated workspace.')
                      : repos.some((r) => !r.disabledAt)
                        ? t('Uses the project default repository.')
                        : t('No project repository: the agent starts in an empty workspace.')
                  }
                  tone={!config.repositoryBindingId && !repos.some((r) => !r.disabledAt) ? 'warn' : ''}
                >
                  <Select
                    id="af-repository"
                    label={t('Repository')}
                    value={config.repositoryBindingId ?? ''}
                    onChange={(id) => update({ repositoryBindingId: id || null })}
                    options={[
                      { value: '', label: t('Inherit project repository') },
                      ...repos.filter((r) => !r.disabledAt).map((r) => ({ value: r.id, label: r.name })),
                    ]}
                  />
                </Field>
                <Field
                  label={t('Branch override (optional)')}
                  htmlFor="af-branch"
                  hint={config.repositoryBranch ? t('The branch must exist in the runner checkout.') : t('Uses the repository base branch.')}
                >
                  <input
                    id="af-branch"
                    value={config.repositoryBranch ?? ''}
                    onChange={(e) => update({ repositoryBranch: e.target.value || null })}
                    placeholder={t('Inherit repository base branch')}
                  />
                </Field>
              </div>
            </Section>
            <Section number="03" title={t('Model')} description={t('Only models reported by the selected runners are listed.')}>
              <div className="af-grid">
                <ModelFields config={config} update={update} runners={runners} disabled={busy} />
              </div>
            </Section>
            <Section number="04" title={t('Execution mode')} description={t('A single agent, or Maestro orchestration with subagents.')}>
              <div className="af-grid">
                <Field
                  label={t('Mode')}
                  hint={
                    canMaestro || config.mode === 'maestro'
                      ? config.mode === 'maestro'
                        ? t('Maestro plans, delegates to subagents and reviews.')
                        : t('One agent carries the card from start to finish.')
                      : t('Maestro is unavailable on the selected runners.')
                  }
                  tone={canMaestro || config.mode === 'maestro' ? '' : 'warn'}
                >
                  <div className="af-seg" role="radiogroup" aria-label={t('Execution mode')}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={config.mode === 'standard'}
                      onClick={() => update({ mode: 'standard' })}
                    >
                      {t('Standard')}
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={config.mode === 'maestro'}
                      disabled={!canMaestro && config.mode !== 'maestro'}
                      onClick={() => update({ mode: 'maestro', subagentsEnabled: true })}
                    >
                      Maestro
                    </button>
                  </div>
                </Field>
                <Field
                  label={t('Maestro strategy')}
                  htmlFor="af-strategy"
                  hint={config.mode === 'maestro' ? t(config.maestroStrategy + ' strategy') : t('Only applies to Maestro mode.')}
                >
                  <Select
                    id="af-strategy"
                    label={t('Maestro strategy')}
                    disabled={config.mode !== 'maestro'}
                    value={config.maestroStrategy}
                    onChange={(maestroStrategy) =>
                      update({ maestroStrategy: maestroStrategy as ColumnAutomation['maestroStrategy'] })
                    }
                    options={['balanced', 'best-quality', 'fast', 'economy'].map((value) => ({
                      value,
                      label: t(value),
                    }))}
                  />
                </Field>
                <Field
                  wide
                  label={t('Subagents')}
                  hint={
                    !canSubagents && !config.subagentsEnabled
                      ? t('No selected runner supports subagents.')
                      : config.mode === 'maestro'
                        ? t('Required in Maestro mode.')
                        : t('Optional delegation for parallel work.')
                  }
                  tone={!canSubagents && !config.subagentsEnabled ? 'warn' : ''}
                >
                  <label className="af-switch">
                    <input
                      type="checkbox"
                      disabled={(!canSubagents && !config.subagentsEnabled) || config.mode === 'maestro'}
                      checked={config.subagentsEnabled}
                      onChange={(e) => update({ subagentsEnabled: e.target.checked })}
                    />
                    <span className="af-switch-track" aria-hidden="true" />
                    <span>{t('Allow Maestrly subagents')}</span>
                  </label>
                </Field>
              </div>
            </Section>
            <Section
              number="05"
              title={t('Initialization prompt')}
              description={t('The card context (ID, title, column, workspace, criteria, description) is always sent before these instructions.')}
              actions={
                <button type="button" className="quiet af-small" onClick={() => setTall((v) => !v)}>
                  {t(tall ? 'Collapse prompt' : 'Expand prompt')}
                </button>
              }
            >
              <div className="af-chips">
                <span>{t('Insert')}:</span>
                {VARIABLES.map((variable) => (
                  <button type="button" key={variable} onClick={() => insertVariable(variable)}>
                    {variable.slice(1, -1)}
                  </button>
                ))}
              </div>
              <textarea
                ref={prompt}
                className="af-prompt"
                aria-label={t('Initialization prompt')}
                value={config.promptTemplate}
                rows={tall ? 18 : 7}
                maxLength={100000}
                placeholder={t('Leave empty to use the default task prompt.')}
                onChange={(e) => update({ promptTemplate: e.target.value })}
              />
              <div className="af-preview">
                <div className="af-preview-bar">
                  <label htmlFor="af-preview-card">{t('Preview with')}</label>
                  <Select
                    id="af-preview-card"
                    label={t('Preview card')}
                    value={previewCard}
                    onChange={(id) => {
                      setPreviewCard(id)
                      if (preview !== null) void operation(() => loadPreview(id))
                    }}
                    options={cards.map((card) => ({ value: card.id, label: card.id.slice(0, 8) + ' · ' + card.title }))}
                  />
                  <button
                    type="button"
                    className="quiet af-small"
                    disabled={!previewCard || busy}
                    aria-expanded={preview !== null}
                    onClick={() => (preview !== null ? setPreview(null) : void operation(() => loadPreview()))}
                  >
                    {t(preview !== null ? 'Hide rendered prompt' : 'Show rendered prompt')}
                  </button>
                </div>
                {preview !== null ? (
                  <div className="af-preview-body" aria-label={t('Rendered prompt')}>
                    <Markdown value={preview} />
                  </div>
                ) : null}
              </div>
            </Section>
            <section className="af-sec af-sec-adv" aria-label={t('Advanced')}>
              <button
                type="button"
                className="af-sec-head af-sec-toggle"
                aria-expanded={advanced}
                aria-controls="af-advanced"
                onClick={() => setAdvanced((v) => !v)}
              >
                <span className="af-num">06</span>
                <div>
                  <h3>{t('Advanced')}</h3>
                  <p>{t('Pre-commands and limits. Rarely needs changes.')}</p>
                </div>
                <ChevronDown size={16} aria-hidden="true" />
              </button>
              {advanced ? (
                <div id="af-advanced" className="af-adv-body">
                  <div className="af-grid">
                    <Field
                      wide
                      label={t('Pre-commands')}
                      htmlFor="af-precommands"
                      hint={
                        canCommands
                          ? t('One command per line. They run in the approved isolated image, without host credentials or network.')
                          : t('No runner has an approved command sandbox image. Configure it on the runner and restart.')
                      }
                      tone={canCommands ? '' : 'warn'}
                    >
                      <textarea
                        id="af-precommands"
                        aria-label={t('Pre-commands')}
                        disabled={!canCommands}
                        value={config.preCommands.join('\n')}
                        rows={3}
                        onChange={(e) => update({ preCommands: e.target.value.split('\n') })}
                      />
                    </Field>
                    <Field label={t('Timeout (seconds)')} htmlFor="af-timeout" hint={t('Inherit board limit')}>
                      <input
                        id="af-timeout"
                        type="number"
                        min={1}
                        max={86400}
                        value={config.maxDurationSeconds ?? ''}
                        placeholder={t('Inherit board limit')}
                        onChange={(e) => update({ maxDurationSeconds: e.target.value ? Number(e.target.value) : null })}
                      />
                    </Field>
                    <Field label={t('Log limit (bytes)')} htmlFor="af-logs" hint={t('Inherit board limit')}>
                      <input
                        id="af-logs"
                        type="number"
                        min={1}
                        max={10485760}
                        value={config.maxLogBytes ?? ''}
                        placeholder={t('Inherit board limit')}
                        onChange={(e) => update({ maxLogBytes: e.target.value ? Number(e.target.value) : null })}
                      />
                    </Field>
                  </div>
                </div>
              ) : null}
            </section>
          </fieldset>
        ) : null}
      </div>
      <footer className="af-footer">
        <p
          className={'af-status' + (statusTone ? ' ' + statusTone : '')}
          role={statusTone === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          <i className="af-dot" />
          <span>{statusText}</span>
        </p>
        <div className="af-footer-actions">
          <button type="button" className="quiet" onClick={onClose}>
            {t('Close')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!loaded || busy || !normal || (config.enabled && !modelValid)}
            onClick={() =>
              void operation(async () => {
                if (!loaded) return
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
      </footer>
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
              <button
                key={version.id}
                type="button"
                className="quiet"
                aria-pressed={chosen?.id === version.id}
                onClick={() => setChosen(version)}
              >
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
                  type="button"
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
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void operation(async () => {
                      const result = await write<{ policyId: string; version: number; config: ColumnAutomation }>(
                        base + '/restore',
                        'POST',
                        { expectedPolicyId: loaded?.policyId ?? null, policyId: chosen.id }
                      )
                      if (loaded) setLoaded({ ...loaded, ...result })
                      setConfig(result.config)
                      setDirty(false)
                      setSaved(true)
                      setHistory(null)
                      setChosen(null)
                      onSaved()
                    })
                  }
                >
                  {t('Restore version')}
                </button>
              </div>
            </>
          ) : null}
        </Modal>
      ) : null}
    </Modal>
  )
}
