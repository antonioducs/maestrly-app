import { useEffect, useState } from 'react'
import { Bot, LockKeyhole, Settings2 } from 'lucide-react'
import type { Board, BoardColumn, ExecutionPolicy } from '@maestrly/protocol'
import { api } from '../../app/api.js'
import { t, useLocale, errorText } from '../../i18n/index.js'
import { AutomationEditor } from './AutomationEditor.js'
import { BoardAutomationSettings } from './BoardAutomationSettings.js'
export function AutomationPanel({
  organizationId,
  projectId,
  board,
  columns,
  onChanged,
}: {
  organizationId: string
  projectId: string
  board: Board
  columns: BoardColumn[]
  onChanged(): void
}) {
  useLocale()
  const [policies, setPolicies] = useState<ExecutionPolicy[]>([]),
    [editing, setEditing] = useState<string | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setEditing(null)
    void api<ExecutionPolicy[]>(`/api/v1/organizations/${organizationId}/projects/${projectId}/policies`)
      .then((items) => {
        if (active) setPolicies(items)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [organizationId, projectId, board.id])
  useEffect(() => {
    void api<ExecutionPolicy[]>(`/api/v1/organizations/${organizationId}/projects/${projectId}/policies`)
      .then(setPolicies)
      .catch((e) => setError(e.message))
  }, [columns, organizationId, projectId])
  return (
    <section className="settings-panel">
      <header>
        <Bot />
        <div>
          <p className="eyebrow">
            {t('Board')}: {board.name}
          </p>
          <h2>{t('Column automations')}</h2>
        </div>
      </header>
      <p className="form-note">{t('Each normal column has its own agent, model, prompt and execution settings.')}</p>
      <BoardAutomationSettings organizationId={organizationId} board={board} columns={columns} onChanged={onChanged} />
      <div className="automation-column-list">
        {columns.map((column) => {
          const policy = policies.find((p) => p.id === column.executionPolicyId),
            config = policy?.automationConfig
          const fixed = column.role === 'backlog' || column.role === 'done'
          return (
            <article key={column.id}>
              <div className="automation-column-icon">{fixed ? <LockKeyhole size={19} /> : <Bot size={19} />}</div>
              <div>
                <h3>{column.name}</h3>
                <p>
                  {t(
                    fixed
                      ? 'Fixed column'
                      : policy?.enabled
                        ? (config?.autoRun ?? true)
                          ? 'Automatic on entry'
                          : 'Manual execution'
                        : 'Agent disabled'
                  )}
                </p>
                {policy && !fixed ? (
                  <p>
                    {policy.provider === 'codex' ? 'Codex' : policy.provider === 'maestrly' ? 'Maestrly' : 'Claude Agent SDK'} · {policy.model}
                    {config?.effort ? ' · ' + t(config.effort) : ''}
                    {config?.fastMode ? ' · Fast' : ''}
                    {config?.mode === 'maestro' ? ' · Maestro' : ''}
                  </p>
                ) : null}
              </div>
              {!fixed ? (
                <button className="quiet" onClick={() => setEditing(column.id)}>
                  <Settings2 size={15} />
                  {t('Configure automation')}
                </button>
              ) : null}
            </article>
          )
        })}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      {editing ? (
        <AutomationEditor
          key={editing}
          organizationId={organizationId}
          columnId={editing}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      ) : null}
    </section>
  )
}
