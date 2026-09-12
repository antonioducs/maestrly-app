import { useState } from 'react'
import { ArrowLeft, ArrowRight, Pencil, Trash2, Plus } from 'lucide-react'
import type { BoardColumn } from '@maestrly/protocol'
import { t, number } from '../../i18n/index.js'
import { FormDialog } from '../../components/FormDialog.js'
import { Select } from '../../components/Select.js'
export function ColumnControls({
  column,
  columns,
  count,
  cardIds = [],
  onManage,
}: {
  column?: BoardColumn
  columns: BoardColumn[]
  count: number
  cardIds?: string[]
  onManage(body: Record<string, unknown>): Promise<void>
}) {
  const [action, setAction] = useState<'create' | 'rename' | 'delete' | null>(null)
  const [destination, setDestination] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const index = columns.findIndex((c) => c.id === column?.id)
  async function reorder(delta: number) {
    const order = columns.map((c) => c.id),
      target = index + delta
    if (target < 0 || target >= order.length || columns[target]?.role==='backlog'||columns[target]?.role==='done') return
    ;[order[index], order[target]] = [order[target], order[index]]
    setBusy(true)
    setError('')
    try {
      await onManage({ action: 'reorder', order })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="column-controls">
      {column ? (
        <>
          <button
            className="icon-button"
            title={t('Move column left')}
            aria-label={t('Move column left') + ' ' + column.name}
            disabled={busy || index === 0 || columns[index-1]?.role==='backlog'}
            onClick={() => void reorder(-1)}
          >
            <ArrowLeft size={13} />
          </button>
          <button
            className="icon-button"
            title={t('Move column right')}
            aria-label={t('Move column right') + ' ' + column.name}
            disabled={busy || index === columns.length - 1 || columns[index+1]?.role==='done'}
            onClick={() => void reorder(1)}
          >
            <ArrowRight size={13} />
          </button>
          <button
            className="icon-button"
            aria-label={t('Rename column') + ' ' + column.name}
            onClick={() => setAction('rename')}
          >
            <Pencil size={13} />
          </button>
          <button
            className="icon-button"
            aria-label={t('Delete column') + ' ' + column.name}
            onClick={() => {
              setDestination(columns.find((c) => c.id !== column.id)?.id ?? '')
              setAction('delete')
            }}
          >
            <Trash2 size={13} />
          </button>
        </>
      ) : (
        <button className="quiet" onClick={() => setAction('create')}>
          <Plus size={15} />
          {t('Add column')}
        </button>
      )}
      {error ? <span role="alert">{t(error)}</span> : null}
      {action ? (
        <FormDialog
          title={t(action === 'create' ? 'Add column' : action === 'rename' ? 'Rename column' : 'Delete column')}
          submitLabel={t(action === 'delete' ? 'Delete' : 'Save changes')}
          onClose={() => setAction(null)}
          onSubmit={async (data) => {
            const name = String(data.get('name') ?? '').trim()
            if (action !== 'delete' && !name) throw new Error('Enter a column name.')
            if (action === 'delete' && count && !destination) throw new Error('Choose another column for the cards.')
            await onManage({
              action,
              ...(column ? { columnId: column.id } : {}),
              ...(action === 'delete'
                ? { expectedCardIds: cardIds, ...(destination ? { destinationId: destination } : {}) }
                : { name }),
            })
          }}
        >
          {action !== 'delete' ? (
            <label>
              {t('Column name')}
              <input name="name" required maxLength={120} defaultValue={column?.name ?? ''} />
            </label>
          ) : (
            <>
              <p>
                {column?.name} · {number(count)} {t('cards')}
              </p>
              <p>{t('Cards will be moved without starting automations. Execution history is preserved.')}</p>
              {count ? (
                <div className="select-field">
                  {t('Move cards to')}
                  <Select
                    label={t('Move cards to')}
                    value={destination}
                    onChange={setDestination}
                    options={columns.filter((c) => c.id !== column?.id).map((c) => ({ value: c.id, label: c.name }))}
                  />
                </div>
              ) : null}
            </>
          )}
        </FormDialog>
      ) : null}
    </div>
  )
}
