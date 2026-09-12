import { useEffect, useState } from 'react'
import type { BoardColumn, Card, ColumnAutomation } from '@maestrly/protocol'
import { Monitor } from 'lucide-react'
import { api, write } from '../../app/api.js'
import { t, useLocale, errorText } from '../../i18n/index.js'
import { FormDialog } from '../../components/FormDialog.js'
import { Select } from '../../components/Select.js'
import { Markdown } from '../../components/Markdown.js'
import { ConnectDesktop } from './ConnectDesktop.js'
interface Preview {
  cardVersion: number
  policyId: string | null
  overrideVersion: number
  renderedPrompt: string
  effective: ColumnAutomation
  config: ColumnAutomation
  active: boolean
  blocked: boolean
  error?: string
  column: { id: string; name: string }
  personalDevices: Array<{
    id: string
    name: string
    enabled: boolean
    online: boolean
    compatible: boolean
    reasons: string[]
  }>
}
export function PersonalExecutionDialog({
  card,
  onClose,
  onExecuted,
}: {
  card: Card
  onClose(): void
  onExecuted(): void
}) {
  useLocale()
  const [columns, setColumns] = useState<BoardColumn[]>([]),
    [columnId, setColumnId] = useState(''),
    [deviceId, setDeviceId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0)
  const base = `/api/v1/organizations/${card.organizationId}/cards/${card.id}`
  useEffect(() => {
    let active = true
    void api<{ columns: BoardColumn[] }>(`/api/v1/organizations/${card.organizationId}/boards/${card.boardId}`)
      .then((board) => {
        if (!active) return
        const normal = board.columns.filter((c) => c.role === 'normal' && c.executionPolicyId)
        setColumns(normal)
        setColumnId(normal.find((c) => c.id === card.columnId)?.id ?? normal[0]?.id ?? '')
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [card.organizationId, card.boardId, card.columnId])
  useEffect(() => {
    if (!columnId) return
    let active = true
    setPreview(null)
    setError('')
    void api<Preview>(base + '/automation?columnId=' + encodeURIComponent(columnId))
      .then((value) => {
        if (active) {
          setPreview(value)
          setDeviceId((current) =>
            value.personalDevices.some((d) => d.id === current) ? current : (value.personalDevices[0]?.id ?? '')
          )
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [base, columnId, refresh])
  const device = preview?.personalDevices.find((d) => d.id === deviceId),
    moving = columnId !== card.columnId
  const invalid =
    !preview ||
    !device?.enabled ||
    !device.compatible ||
    !preview.config.enabled ||
    preview.blocked ||
    preview.active ||
    !!preview.error
  return (
    <FormDialog
      title={t('Run on my computer')}
      submitLabel={t(moving ? 'Move and execute on my computer' : 'Request personal execution')}
      submitDisabled={invalid}
      onClose={onClose}
      onSubmit={async () => {
        if (invalid || !preview || !device) throw new Error('Choose an enabled compatible personal device.')
        try {
          if (moving)
            await write(base + '/move', 'POST', {
              expectedVersion: preview.cardVersion,
              targetColumnId: columnId,
              targetPosition: 0,
              source: 'human',
              allowAutomationChain: false,
              chainDepth: 0,
              personalExecution: {
                deviceId,
                expectedPolicyId: preview.policyId,
                expectedOverrideVersion: preview.overrideVersion,
              },
            })
          else {
            const result = await write<{ jobId: string | null; reason?: string }>(base + '/automation/run', 'POST', {
              expectedVersion: preview.cardVersion,
              expectedPolicyId: preview.policyId,
              expectedOverrideVersion: preview.overrideVersion,
              personalDeviceId: deviceId,
            })
            if (!result.jobId) throw new Error(result.reason ?? 'Execution could not be requested.')
          }
          onExecuted()
        } catch (e) {
          setRefresh((r) => r + 1)
          throw e
        }
      }}
    >
      <p className="personal-task">
        <Monitor size={18} />
        <strong>{card.title}</strong>
      </p>
      <div className="select-field">
        {t('Execution column')}
        <Select
          label={t('Execution column')}
          value={columnId}
          onChange={setColumnId}
          options={columns.map((c) => ({ value: c.id, label: c.name }))}
        />
      </div>
      {!columns.length ? <p>{t('Configure an agent on a normal column before requesting execution.')}</p> : null}
      {preview ? (
        <>
          {preview.personalDevices.length ? (
            <div className="select-field">
              {t('My computer')}
              <Select
                label={t('My computer')}
                value={deviceId}
                onChange={setDeviceId}
                options={preview.personalDevices.map((d) => ({
                  value: d.id,
                  label:
                    d.name + ' · ' + t(!d.enabled ? 'Personal execution disabled' : d.online ? 'Online' : 'Offline'),
                }))}
              />
            </div>
          ) : (
            <p>{t('No personal computer connected for this project.')}</p>
          )}
          {device && !device.online && device.enabled ? (
            <p role="status" className="personal-offline">
              {t('This computer is offline. The job will wait for it and will never move to another machine.')}
            </p>
          ) : null}
          {device && !device.enabled ? <p>{t('Open Maestrly desktop and enable personal execution.')}</p> : null}
          {device && !device.compatible ? (
            <p className="form-error">{device.reasons.map((reason) => t(reason)).join(' · ')}</p>
          ) : null}
          {preview.active ? <p>{t('An execution is already queued or active for this card.')}</p> : null}
          {preview.blocked ? <p>{t('Dispatch limit reached. Release this card to continue.')}</p> : null}
          {!preview.config.enabled ? <p>{t('The agent is disabled for this column.')}</p> : null}
          <div className="personal-preview">
            <p>
              {preview.effective.provider === 'codex' ? 'Codex' : preview.effective.provider === 'maestrly' ? 'Maestrly' : 'Claude Agent SDK'} · {preview.effective.model} ·{' '}
              {t(preview.effective.mode)}
            </p>
            <Markdown value={preview.renderedPrompt} />
          </div>
          {preview.effective.approvalRequired ? <p>{t('This execution requires approval before it starts.')}</p> : null}
          {preview.error ? <p className="form-error">{errorText(preview.error)}</p> : null}
        </>
      ) : columnId && !error ? (
        <p role="status">{t('Loading…')}</p>
      ) : null}
      <p className="form-note">
        {t(
          'This request uses your selected device instead of the column destination. The column configuration stays the same.'
        )}
      </p>
      <button className="quiet" type="button" onClick={() => setRefresh((r) => r + 1)}>
        {t('Refresh computers')}
      </button>
      <ConnectDesktop />
      {error ? (
        <p role="alert" className="form-error">
          {errorText(error)}
        </p>
      ) : null}
    </FormDialog>
  )
}
