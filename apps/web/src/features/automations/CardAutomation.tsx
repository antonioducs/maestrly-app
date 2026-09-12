import { PersonalExecutionDialog } from '../devices/PersonalExecutionDialog.js'
import { useEffect, useState } from 'react'
import type { Card, BoardColumn, ColumnAutomation, CardAutomationOverride } from '@maestrly/protocol'
import { api, write } from '../../app/api.js'
import { t, useLocale, errorText } from '../../i18n/index.js'
import { Select } from '../../components/Select.js'
import { FormDialog } from '../../components/FormDialog.js'
import { Markdown } from '../../components/Markdown.js'
import { catalogModels, type CatalogRunner } from './ModelFields.js'
interface Context {
  column: { id: string; name: string; role: string }
  policyId: string | null
  cardVersion: number
  config: ColumnAutomation
  effective: ColumnAutomation
  override: CardAutomationOverride | null
  overrideVersion: number
  renderedPrompt: string
  error?: string
  blocked: boolean
  dispatchCount: number
  active: boolean
  runners: Array<{ runnerId: string; name: string; compatible: boolean; reasons: string[] }>
}
export function CardAutomation({
  card,
  readOnly,
  beforeRun,
  onChanged,
}: {
  card: Card
  readOnly: boolean
  beforeRun(): Promise<boolean>
  onChanged(): void
}) {
  useLocale()
  const [personal,setPersonal]=useState(false)
  const [columns, setColumns] = useState<BoardColumn[]>([]),
    [columnId, setColumnId] = useState(card.columnId)
  const [context, setContext] = useState<Context | null>(null),
    [override, setOverride] = useState<CardAutomationOverride>({})
  const [runners, setRunners] = useState<CatalogRunner[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<Context | null>(null)
  const base = `/api/v1/organizations/${card.organizationId}/cards/${card.id}/automation`
  const load = async () => {
    const result = await api<Context>(base + '?columnId=' + columnId)
    setContext(result)
    setOverride(result.override ?? {})
    return result
  }
  useEffect(() => {
    let active = true
    void Promise.all([
      api<{ columns: BoardColumn[] }>(`/api/v1/organizations/${card.organizationId}/boards/${card.boardId}`),
      api<{ runners: CatalogRunner[] }>(
        `/api/v1/organizations/${card.organizationId}/projects/${card.projectId}/automation-catalog`
      ),
    ])
      .then(([board, catalog]) => {
        if (active) {
          setColumns(board.columns)
          setRunners(catalog.runners)
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [card.id, card.boardId, card.projectId, card.organizationId])
  useEffect(() => {
    let active = true
    setContext(null)
    void api<Context>(base + '?columnId=' + columnId)
      .then((data) => {
        if (active) {
          setContext(data)
          setOverride(data.override ?? {})
          setError('')
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [base, columnId])
  async function operation(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save policy.')
    } finally {
      setBusy(false)
    }
  }
  function field(key: keyof CardAutomationOverride, value: string | boolean | undefined) {
    setOverride((current) => {
      const next = { ...current, [key]: value }
      if (value === undefined) delete next[key]
      return next as CardAutomationOverride
    })
  }
  const provider = override.provider ?? context?.config.provider
  const models = catalogModels(
    runners,
    context?.config.runnerSelector === 'runner' ? context.config.targetRunnerId : null
  ).filter((m) => m.provider === provider)
  const model = override.model ?? context?.config.model
  const selected = models.filter((m) => m.model === model),
    efforts = [...new Set(selected.flatMap((m) => m.efforts))],
    fast = selected.some((m) => m.fastMode)
  const normal = context?.column.role === 'normal',
    canWrite = !readOnly && !card.archivedAt
  return (
    <section className="card-section">
      <header>
        <h3>{t('Column agent')}</h3>
      </header>
      <div className="select-field">
        {t('Column')}
        <Select
          label={t('Override column')}
          value={columnId}
          onChange={setColumnId}
          options={columns.map((c) => ({ value: c.id, label: c.name }))}
        />
      </div>
      {context ? (
        <>
          <p className="form-note">
            {t('Effective configuration')}: {context.effective.provider} ·{' '}
            {context.effective.model || t('Not configured')} · {t(context.effective.effort ?? 'Model default')}
            {context.effective.fastMode ? ' · Fast' : ''}
          </p>
          {normal ? (
            <>
              <p className="form-note">
                {t('Only overridden fields change. Other settings are inherited from this column.')}
              </p>
              <fieldset className="automation-fields policy-grid" disabled={!canWrite || busy}>
                <div className="select-field">
                  {t('Provider')}
                  <Select
                    label={t('Override provider')}
                    value={override.provider ?? ''}
                    onChange={(value) => {
                      setOverride((current) => ({
                        ...current,
                        provider: (value as CardAutomationOverride['provider']) || undefined,
                        model: undefined,
                        effort: undefined,
                        fastMode: undefined,
                      }))
                    }}
                    options={[
                      { value: '', label: t('Inherit from column') },
                      ...[...new Set(catalogModels(runners, null).map((m) => m.provider))].map((value) => ({
                        value,
                        label: value === 'codex' ? 'Codex' : value === 'maestrly' ? 'Maestrly' : 'Claude Agent SDK',
                      })),
                    ]}
                  />
                </div>
                <div className="select-field">
                  {t('Model')}
                  <Select
                    label={t('Override model')}
                    value={override.model ?? ''}
                    onChange={(value) => field('model', value || undefined)}
                    options={[
                      { value: '', label: t('Inherit from column') },
                      ...[...new Map(models.map((m) => [m.model, m])).values()].map((m) => ({
                        value: m.model,
                        label: m.label,
                      })),
                    ]}
                  />
                </div>
                {efforts.length ? (
                  <div className="select-field">
                    {t('Reasoning effort')}
                    <Select
                      label={t('Override effort')}
                      value={override.effort ?? ''}
                      onChange={(value) => field('effort', value || undefined)}
                      options={[
                        { value: '', label: t('Inherit from column') },
                        { value: 'off', label: t('Model default') },
                        ...efforts.map((value) => ({ value, label: t(value) })),
                      ]}
                    />
                  </div>
                ) : null}
                {fast ? (
                  <div className="select-field">
                    {t('Fast mode')}
                    <Select
                      label={t('Override fast mode')}
                      value={override.fastMode === undefined ? 'inherit' : String(override.fastMode)}
                      onChange={(value) => field('fastMode', value === 'inherit' ? undefined : value === 'true')}
                      options={[
                        { value: 'inherit', label: t('Inherit from column') },
                        { value: 'true', label: t('Enabled') },
                        { value: 'false', label: t('Disabled') },
                      ]}
                    />
                  </div>
                ) : null}
              </fieldset>
              {canWrite ? (
                <div className="dialog-actions">
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() =>
                      void operation(async () => {
                        await write(base + '/override', 'PUT', {
                          columnId,
                          expectedVersion: context.overrideVersion,
                          config: null,
                        })
                        await load()
                        onChanged()
                      })
                    }
                  >
                    {t('Use column configuration')}
                  </button>
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() =>
                      void operation(async () => {
                        await write(base + '/override', 'PUT', {
                          columnId,
                          expectedVersion: context.overrideVersion,
                          config: override,
                        })
                        await load()
                        onChanged()
                      })
                    }
                  >
                    {t('Save overrides')}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <p className="form-note">{t('Fixed columns cannot run automations.')}</p>
          )}
          {context.blocked ? (
            <div className="conflict-box">
              <p>{t('Dispatch limit reached. Release this card to continue.')}</p>
              {canWrite ? (
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() =>
                    void operation(async () => {
                      await write(base + '/release', 'POST', { columnId })
                      await load()
                      onChanged()
                    })
                  }
                >
                  {t('Release dispatch')}
                </button>
              ) : null}
            </div>
          ) : null}
          {context.error ? <p className="form-error">{errorText(context.error)}</p> : null}
          {normal ? (
            <div className="runner-assessments">
              {context.runners.map((r) => (
                <p key={r.runnerId}>
                  <strong>{r.name}</strong> ·{' '}
                  {r.compatible ? t('Compatible') : r.reasons.map((reason) => t(reason)).join(' · ')}
                </p>
              ))}
              {!context.runners.length ? <p>{t('No runner is enrolled')}</p> : null}
            </div>
          ) : null}
          {canWrite && normal ? (
            <button
              className="primary"
              disabled={
                busy ||
                columnId !== card.columnId ||
                !context.config.enabled ||
                context.active ||
                context.blocked ||
                !context.runners.some((r) => r.compatible)
              }
              onClick={() =>
                void operation(async () => {
                  if (!(await beforeRun())) throw new Error('Resolve the description conflict before continuing.')
                  setConfirm(await load())
                })
              }
            >
              {t('Run agent')}
            </button>
          ) : null}
          {columnId !== card.columnId ? (
            <p className="form-note">
              {t('Overrides can be prepared for another column. Manual execution uses the current column only.')}
            </p>
          ) : null}
          {context.active ? (
            <p className="form-note">{t('An execution is already queued or active for this card.')}</p>
          ) : null}
          {!context.config.enabled && normal ? (
            <p className="form-note">{t('The agent is disabled for this column.')}</p>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      {canWrite?<button className="quiet" disabled={busy} onClick={()=>void operation(async()=>{if(!(await beforeRun()))throw new Error('Resolve the description conflict before continuing.');setPersonal(true)})}>{t('Run on my computer')}</button>:null}
      {personal?<PersonalExecutionDialog card={card} onClose={()=>setPersonal(false)} onExecuted={()=>{void load();onChanged()}}/>:null}
      {confirm ? (
        <FormDialog
          title={t('Run agent')}
          submitLabel={t('Request execution')}
          onClose={() => setConfirm(null)}
          onSubmit={async () => {
            const result = await write<{ jobId: string | null; reason?: string }>(base + '/run', 'POST', {
              expectedVersion: confirm.cardVersion,
              expectedPolicyId: confirm.policyId,
              expectedOverrideVersion: confirm.overrideVersion,
            })
            await load()
            onChanged()
            if (!result.jobId) throw new Error(result.reason ?? 'Execution could not be requested.')
          }}
        >
          <p>
            {card.title} · {confirm.column.name}
          </p>
          <p>
            {confirm.effective.provider} · {confirm.effective.model} · {t(confirm.effective.mode)}
          </p>
          <Markdown value={confirm.renderedPrompt} />
          <p className="form-note">{t('The resolved configuration and prompt will be frozen for this execution.')}</p>
        </FormDialog>
      ) : null}
    </section>
  )
}
