import { useState } from 'react'
import type { Board } from '@maestrly/protocol'
import { Plus, Pencil, Archive } from 'lucide-react'
import { FormDialog } from '../../components/FormDialog.js'
import { Select } from '../../components/Select.js'
import { t, useLocale } from '../../i18n/index.js'
import { write } from '../../app/api.js'

export function BoardTabs({
  boards,
  selectedId,
  organizationId,
  projectId,
  readOnly,
  onSelect,
  onReload,
}: {
  boards: Board[]
  selectedId: string
  organizationId: string
  projectId: string
  readOnly: boolean
  onSelect(id: string): void
  onReload(): Promise<void>
}) {
  const locale = useLocale()
  const [action, setAction] = useState<'create' | 'rename' | 'archive' | null>(null)
  const [template, setTemplate] = useState('complete'),
    [showArchived, setShowArchived] = useState(false),
    [restoring, setRestoring] = useState<Board | null>(null)
  const active = boards.find((b) => b.id === selectedId)
  const close = () => setAction(null)
  async function change(board: Board, patch: Record<string, unknown>) {
    await write(`/api/v1/organizations/${organizationId}/boards/${board.id}`, 'PATCH', {
      expectedVersion: board.version,
      ...patch,
    })
    await onReload()
  }
  return (
    <div className="board-management">
      <div className="board-tabs" aria-label={t('Project boards')}>
        {boards
          .filter((b) => !b.archivedAt)
          .map((board) => (
            <button
              className="quiet"
              aria-pressed={board.id === selectedId}
              key={board.id}
              onClick={() => onSelect(board.id)}
            >
              {board.name}
            </button>
          ))}
      </div>
      {!readOnly ? (
        <div className="board-management-actions">
          <button className="icon-button" aria-label={t('Create board')} onClick={() => setAction('create')}>
            <Plus size={16} />
          </button>
          {active ? (
            <>
              <button className="icon-button" aria-label={t('Rename board')} onClick={() => setAction('rename')}>
                <Pencil size={14} />
              </button>
              <button className="icon-button" aria-label={t('Archive board')} onClick={() => setAction('archive')}>
                <Archive size={14} />
              </button>
            </>
          ) : null}
          <button className="quiet" onClick={() => setShowArchived(!showArchived)}>
            {t('Archived boards')}
          </button>
        </div>
      ) : null}
      {showArchived ? (
        <div className="archived-boards">
          {boards
            .filter((b) => b.archivedAt)
            .map((board) => (
              <div key={board.id}>
                <span>{board.name}</span>
                <button className="quiet" onClick={() => setRestoring(board)}>
                  {t('Restore')}
                </button>
              </div>
            ))}
          {!boards.some((b) => b.archivedAt) ? <p>{t('No archived boards.')}</p> : null}
        </div>
      ) : null}
      {restoring ? (
        <FormDialog
          title={t('Restore board')}
          submitLabel={t('Restore')}
          onClose={() => setRestoring(null)}
          onSubmit={async () => {
            await change(restoring, { archived: false })
            onSelect(restoring.id)
          }}
        >
          <p>{restoring.name}</p>
        </FormDialog>
      ) : null}
      {action ? (
        <FormDialog
          title={t(action === 'create' ? 'Create board' : action === 'rename' ? 'Rename board' : 'Archive board')}
          submitLabel={t(action === 'archive' ? 'Archive' : 'Save changes')}
          onClose={close}
          onSubmit={async (data) => {
            if (action === 'create') {
              const name = String(data.get('name') ?? '').trim()
              if (!name) throw new Error('Enter a board name.')
              const created = await write<Board>(
                `/api/v1/organizations/${organizationId}/projects/${projectId}/boards`,
                'POST',
                { name, template, locale }
              )
              await onReload()
              onSelect(created.id)
            } else if (active) {
              const name = String(data.get('name') ?? '').trim()
              if (action === 'rename' && !name) throw new Error('Enter a board name.')
              await change(active, action === 'archive' ? { archived: true } : { name })
            }
          }}
        >
          {action === 'archive' ? (
            <p>{t('This board will be hidden. Cards and execution history are preserved.')}</p>
          ) : (
            <label>
              {t('Board name')}
              <input name="name" required maxLength={160} defaultValue={action === 'rename' ? active?.name : ''} />
            </label>
          )}
          {action === 'create' ? (
            <div className="select-field">
              {t('Template')}
              <Select
                value={template}
                onChange={setTemplate}
                label={t('Template')}
                options={['complete', 'simple', 'blank'].map((value) => ({ value, label: t(value) }))}
              />
            </div>
          ) : null}
        </FormDialog>
      ) : null}
    </div>
  )
}
