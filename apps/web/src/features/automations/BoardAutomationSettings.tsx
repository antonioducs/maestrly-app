import { useState } from 'react'
import { automationDefaults, type Board, type BoardColumn, type AutomationLimits } from '@maestrly/protocol'
import { FormDialog } from '../../components/FormDialog.js'
import { Select } from '../../components/Select.js'
import { t } from '../../i18n/index.js'
import { write } from '../../app/api.js'
export function BoardAutomationSettings({
  organizationId,
  board,
  columns,
  onChanged,
}: {
  organizationId: string
  board: Board
  columns: BoardColumn[]
  onChanged(): void
}) {
  const [panel, setPanel] = useState<'limits' | 'roles' | null>(null)
  const [create, setCreate] = useState(columns.length < 2),
    [backlog, setBacklog] = useState(columns[0]?.id ?? ''),
    [done, setDone] = useState(columns.at(-1)?.id ?? '')
  const base = `/api/v1/organizations/${organizationId}/boards/${board.id}`
  const fields: Array<[keyof AutomationLimits, string]> = [
    ['maxPerCardPerColumn', 'Maximum starts per card/column'],
    ['breakerWindowMs', 'Counting window (milliseconds)'],
    ['maxDurationSeconds', 'Timeout (seconds)'],
    ['maxLogBytes', 'Log limit (bytes)'],
  ]
  return (
    <div className="board-automation-settings">
      {board.rolesConfigured === false ? (
        <div className="repository-note">
          <p>{t('This board needs explicit Backlog and Done columns before enabling automation.')}</p>
          <button className="primary" onClick={() => setPanel('roles')}>
            {t('Define fixed columns')}
          </button>
        </div>
      ) : null}
      <button className="quiet" onClick={() => setPanel('limits')}>
        {t('Automation limits')}
      </button>
      {panel === 'limits' ? (
        <FormDialog
          title={t('Automation limits')}
          submitLabel={t('Save changes')}
          onClose={() => setPanel(null)}
          onSubmit={async (data) => {
            const limits = Object.fromEntries(
              fields.map(([key]) => [key, String(data.get(key) ?? '').trim() ? Number(data.get(key)) : null])
            )
            await write(base + '/automation-limits', 'PUT', { expectedVersion: board.version, limits })
            onChanged()
          }}
        >
          <p className="form-note">
            {t('Empty values inherit the defaults. A blocked card stays blocked until released manually.')}
          </p>
          {fields.map(([key, label]) => (
            <label key={key}>
              {t(label)}
              <input
                name={key}
                type="number"
                min={1}
                defaultValue={board.automationLimits?.[key] ?? ''}
                placeholder={String(automationDefaults[key])}
              />
            </label>
          ))}
        </FormDialog>
      ) : null}
      {panel === 'roles' ? (
        <FormDialog
          title={t('Define fixed columns')}
          submitLabel={t('Confirm')}
          onClose={() => setPanel(null)}
          onSubmit={async () => {
            await write(base + '/fixed-columns', 'POST', {
              expectedVersion: board.version,
              create,
              ...(!create ? { backlogId: backlog, doneId: done } : {}),
            })
            onChanged()
          }}
        >
          <p>
            {t(
              'Fixed columns cannot run agents, be renamed, removed or moved. Existing cards and history are preserved.'
            )}
          </p>
          <label className="check">
            <input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />
            {t('Create new Backlog and Done columns')}
          </label>
          {!create ? (
            <>
              <div className="select-field">
                Backlog
                <Select
                  label="Backlog"
                  value={backlog}
                  onChange={setBacklog}
                  options={columns.map((c) => ({ value: c.id, label: c.name }))}
                />
              </div>
              <div className="select-field">
                Done
                <Select
                  label="Done"
                  value={done}
                  onChange={setDone}
                  options={columns.map((c) => ({ value: c.id, label: c.name }))}
                />
              </div>
            </>
          ) : null}
        </FormDialog>
      ) : null}
    </div>
  )
}
