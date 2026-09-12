import { PersonalExecutionDialog } from '../devices/PersonalExecutionDialog.js'
import { AutomationEditor } from '../automations/AutomationEditor.js'
import { BoardAutomationSettings } from '../automations/BoardAutomationSettings.js'
import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { Bot, CircleDashed, CheckCheck, Inbox, Plus, Search, Columns3, List, Settings2, LockKeyhole, ArrowUp, ArrowDown, MonitorPlay } from 'lucide-react'
import type { Board, BoardColumn, Card } from '@maestrly/protocol'
import type { Operation } from '../executions/types.js'
import { PriorityGlyph } from './PriorityGlyph.js'
import { t, useLocale, number, errorText } from '../../i18n/index.js'
import { write } from '../../app/api.js'
import { Select } from '../../components/Select.js'
import { FormDialog } from '../../components/FormDialog.js'
import { MarkdownEditor } from '../../components/Markdown.js'
import { CardDialog } from '../cards/CardDialog.js'
import { ColumnControls } from './ColumnControls.js'
import { EmptyState } from '../../components/EmptyState.js'

export interface BoardSnapshot {
  board: Board
  columns: BoardColumn[]
  cards: Card[]
  archivedCards?: Card[]
}
export function BoardView({
  organizationId,
  snapshot,
  readOnly = false,
  canManageAutomation=false,
  executions = [],
  onReload,
}: {
  organizationId: string
  snapshot: BoardSnapshot
  readOnly?: boolean
  canManageAutomation?:boolean
  executions?: Operation[]
  onReload(): void
}) {
  useLocale()
  // One-shot cue for the column that just received a card and started a job.
  const [cue, setCue] = useState<string | null>(null)
  const cueTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Columns with an agent working right now, derived from the execution ledger.
  const liveColumns = useMemo(() => {
    const columnByCard = new Map(snapshot.cards.map((c) => [c.id, c.columnId]))
    return new Set(
      executions
        .filter((e) => e.runState === 'running' || e.jobState === 'active')
        .map((e) => columnByCard.get(e.cardId))
        .filter((id): id is string => !!id)
    )
  }, [executions, snapshot.cards])
  const dragDepth = useRef(new Map<string, number>())
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragEnter = (columnId: string) => {
    dragDepth.current.set(columnId, (dragDepth.current.get(columnId) ?? 0) + 1)
    setDropTarget(columnId)
  }
  const dragLeave = (columnId: string) => {
    const depth = (dragDepth.current.get(columnId) ?? 1) - 1
    dragDepth.current.set(columnId, Math.max(0, depth))
    if (depth <= 0) setDropTarget((current) => (current === columnId ? null : current))
  }
  const dragReset = () => {
    dragDepth.current.clear()
    setDropTarget(null)
  }
  const [personalCard,setPersonalCard]=useState<Card|null>(null)
  const [editingAutomation,setEditingAutomation]=useState<string|null>(null)
  const [selected, setSelected] = useState<Card | null>(null),
    [creatingColumn, setCreatingColumn] = useState<string | null>(null)
  const [description, setDescription] = useState(''),
    [query, setQuery] = useState(''),
    [layout, setLayout] = useState('board')
  const [automated, setAutomated] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [error, setError] = useState(''),
    [moving, setMoving] = useState(false)
  const allCards = showArchived ? (snapshot.archivedCards ?? []) : snapshot.cards
  const cardsByColumn = useMemo(
    () =>
      new Map(
        snapshot.columns.map((column) => [
          column.id,
          allCards.filter(
            (card) =>
              !card.parentCardId &&
              card.columnId === column.id &&
              card.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
              (!automated || !!column.executionPolicyId)
          ),
        ])
      ),
    [snapshot, allCards, query, automated]
  )
  async function manage(body: Record<string, unknown>) {
    await write(`/api/v1/organizations/${organizationId}/boards/${snapshot.board.id}/columns/manage`, 'POST', {
      expectedVersion: snapshot.board.version,
      ...body,
    })
    onReload()
  }
  async function move(card: Card, columnId: string, position = 0) {
    if (readOnly || moving || showArchived) return
    setMoving(true)
    setError('')
    try {
      const result = await write<{ card: Card; jobId?: string }>(
        `/api/v1/organizations/${organizationId}/cards/${card.id}/move`,
        'POST',
        {
          expectedVersion: card.version,
          targetColumnId: columnId,
          targetPosition: position,
          source: 'human',
          allowAutomationChain: false,
          chainDepth: 0,
        }
      )
      if (result?.jobId) {
        setCue(columnId)
        if (cueTimer.current) clearTimeout(cueTimer.current)
        cueTimer.current = setTimeout(() => setCue(null), 1600)
      }
      onReload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save. Please try again.')
    } finally {
      setMoving(false)
    }
  }
  async function dropColumn(source: string, target: string) {
    const order = snapshot.columns.map((c) => c.id)
    if(snapshot.columns.find(c=>c.id===source)?.role!=='normal')return
    if (!order.includes(source) || !order.includes(target) || source === target) return
    order.splice(order.indexOf(source), 1)
    order.splice(order.indexOf(target), 0, source)
    try {
      await manage({ action: 'reorder', order })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save. Please try again.')
    }
  }
  return (
    <div className="board-workspace">
      {canManageAutomation&&snapshot.board.rolesConfigured===false?<BoardAutomationSettings organizationId={organizationId} board={snapshot.board} columns={snapshot.columns} onChanged={onReload}/>:null}
      <div className="board-toolbar">
        <div className="view-tabs">
          <button aria-pressed={layout === 'board'} onClick={() => setLayout('board')}>
            <Columns3 size={15} />
            {t('Board')}
          </button>
          <button aria-pressed={layout === 'list'} onClick={() => setLayout('list')}>
            <List size={15} />
            {t('List')}
          </button>
        </div>
        <label className="board-search">
          <Search size={15} />
          <input
            aria-label={t('Search cards')}
            placeholder={t('Search cards')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button className="quiet" aria-pressed={automated} onClick={() => setAutomated(!automated)}>
          {t(automated ? 'Automations' : 'All cards')}
        </button>
        <button className="quiet" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>
          {t('Archived cards')}
        </button>
        {!readOnly ? <ColumnControls columns={snapshot.columns} count={0} onManage={manage} /> : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {errorText(error)}{' '}
          <button className="quiet" onClick={onReload}>
            {t('Reload')}
          </button>
        </p>
      ) : null}
      {!snapshot.columns.length ? (
        <EmptyState title={t('No columns yet.')}>
          <p>{t('Add a column to start organizing cards.')}</p>
        </EmptyState>
      ) : null}
      <section className={'board ' + (layout === 'list' ? 'board-list' : '')} aria-label={snapshot.board.name}>
        {snapshot.columns.map((column, columnIndex) => {
          const role = column.role ?? 'normal'
          const automated = !!column.executionPolicyId
          const RoleIcon = role === 'backlog' ? Inbox : role === 'done' ? CheckCheck : automated ? Bot : CircleDashed
          const cueState = cue === column.id ? 'fired' : liveColumns.has(column.id) ? 'live' : undefined
          return (
          <section
            className={'board-column' + (dropTarget === column.id ? ' drop-target' : '')}
            key={column.id}
            data-role={role}
            data-automated={automated}
            data-cue={cueState}
            style={{ '--i': columnIndex } as CSSProperties}
            onDragEnter={() => { if (!readOnly) dragEnter(column.id) }}
            onDragLeave={() => dragLeave(column.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              dragReset()
              if (readOnly) return
              const source = e.dataTransfer.getData('text/column-id')
              if (source) {
                void dropColumn(source, column.id)
                return
              }
              const card = snapshot.cards.find((c) => c.id === e.dataTransfer.getData('text/card-id'))
              if (card) void move(card, column.id, snapshot.cards.filter((c) => c.columnId === column.id).length)
            }}
          >
            {automated ? (
              <i className="cue-rail" aria-hidden="true" title={cueState === 'live' ? t('Agent working') : undefined} />
            ) : null}
            <header draggable={!readOnly} onDragStart={(e) => e.dataTransfer.setData('text/column-id', column.id)} onDragEnd={dragReset}>
              <div>
                <RoleIcon size={14} aria-hidden="true" />
                <h2>{column.name}</h2>
                <span>{number(cardsByColumn.get(column.id)?.length ?? 0)}</span>
              </div>
              {role==='backlog'||role==='done'?<LockKeyhole size={15} aria-label={t('Fixed column')}/>:canManageAutomation?<button className="icon-button" aria-label={t('Configure automation')+' '+column.name} onClick={()=>setEditingAutomation(column.id)}><Settings2 size={15}/></button>:automated?<Bot size={15} aria-label={t('Agent automation configured')}/>:null}
            </header>
            {cueState === 'live' ? <p className="agent-working" role="status">{t('Agent working')}</p> : null}
            {!readOnly && (column.role??'normal')==='normal' ? (
              <ColumnControls
                column={column}
                cardIds={[...snapshot.cards, ...(snapshot.archivedCards ?? [])]
                  .filter((c) => c.columnId === column.id)
                  .map((c) => c.id)}
                columns={snapshot.columns}
                count={
                  [...snapshot.cards, ...(snapshot.archivedCards ?? [])].filter((c) => c.columnId === column.id).length
                }
                onManage={manage}
              />
            ) : null}
            <div className="card-stack">
              {cardsByColumn.get(column.id)?.map((card) => {
                const siblings = snapshot.cards.filter((c) => c.columnId === column.id && !c.parentCardId),
                  index = siblings.findIndex((c) => c.id === card.id)
                return (
                  <article
                    className="work-card"
                    key={card.id}
                    data-priority={card.priority}
                    draggable={!readOnly && !showArchived && !moving}
                    onDragStart={(e) => {
                      e.stopPropagation()
                      e.dataTransfer.setData('text/card-id', card.id)
                      e.currentTarget.classList.add('dragging')
                    }}
                    onDragEnd={(e) => {
                      e.currentTarget.classList.remove('dragging')
                      dragReset()
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      const source = snapshot.cards.find((c) => c.id === e.dataTransfer.getData('text/card-id'))
                      if (source) {
                        e.preventDefault()
                        e.stopPropagation()
                        dragReset()
                        if (source.id !== card.id) void move(source, column.id, card.position)
                      }
                    }}
                  >
                    <button className="card-main" onClick={() => setSelected(card)}>
                      <span>{card.title}</span>
                    </button>
                    <div className="card-meta">
                      <PriorityGlyph priority={card.priority} />
                      <code>{card.id.slice(0, 8)}</code>
                      {snapshot.cards.some((c) => c.parentCardId === card.id) ? (
                        <span>
                          ↳ {number(snapshot.cards.filter((c) => c.parentCardId === card.id).length)} {t('Subtasks')}
                        </span>
                      ) : null}
                    </div>
                    <div className="card-foot">
                    <div className="card-tags">
                      {card.automationBlocked?<span className="dispatch-blocked">{t('Dispatch blocked')}</span>:null}
                      {card.labels.map((label) => (
                        <span key={label}>{label}</span>
                      ))}
                    </div>
                    <div className="card-actions">
                      {!readOnly && !showArchived ? (
                        <>
                          <button
                            className="icon-button"
                            disabled={moving || index === 0}
                            aria-label={t('Move card up') + ' ' + card.title}
                            title={t('Move card up')}
                            onClick={() => void move(card, column.id, siblings[index - 1]?.position ?? 0)}
                          >
                            <ArrowUp size={13} />
                          </button>
                          <button
                            className="icon-button"
                            disabled={moving || index === siblings.length - 1}
                            aria-label={t('Move card down') + ' ' + card.title}
                            title={t('Move card down')}
                            onClick={() => void move(card, column.id, siblings[index + 1]?.position ?? siblings.length)}
                          >
                            <ArrowDown size={13} />
                          </button>
                        </>
                      ) : null}
                      <Select
                        compact
                        disabled={readOnly || moving || showArchived}
                        value={column.id}
                        onChange={(value) => void move(card, value)}
                        label={t('Move {title}', { title: card.title })}
                        options={snapshot.columns.map((c) => ({ value: c.id, label: c.name }))}
                      />
                      {!readOnly && !showArchived ? (
                        <button
                          className="icon-button"
                          disabled={moving}
                          aria-label={t('Run on my computer') + ' ' + card.title}
                          title={t('Run on my computer')}
                          onClick={() => setPersonalCard(card)}
                        >
                          <MonitorPlay size={14} />
                        </button>
                      ) : null}
                    </div>
                    </div>
                  </article>
                )
              })}
            </div>
            {!readOnly && !showArchived ? (
              <button
                className="add-card"
                onClick={() => {
                  setDescription('')
                  setCreatingColumn(column.id)
                }}
              >
                <Plus size={15} />
                {t('Add card')}
              </button>
            ) : null}
          </section>
          )
        })}
      </section>
      {personalCard?<PersonalExecutionDialog card={personalCard} onClose={()=>setPersonalCard(null)} onExecuted={onReload}/>:null}
      {creatingColumn ? (
        <FormDialog
          title={t('Create card')}
          submitLabel={t('Create card')}
          onClose={() => setCreatingColumn(null)}
          onSubmit={async (data) => {
            const title = String(data.get('title') ?? '').trim()
            if (!title) throw new Error('Enter a card title.')
            await write(`/api/v1/organizations/${organizationId}/boards/${snapshot.board.id}/cards`, 'POST', {
              columnId: creatingColumn,
              title,
              description,
            })
            onReload()
          }}
        >
          <label>
            {t('Title')}
            <input name="title" required maxLength={500} />
          </label>
          <p className="field-title">{t('Description')}</p>
          <MarkdownEditor label={t('Description')} value={description} onChange={setDescription} />
        </FormDialog>
      ) : null}
      {editingAutomation?<AutomationEditor key={editingAutomation} organizationId={organizationId} columnId={editingAutomation} onClose={()=>setEditingAutomation(null)} onSaved={onReload}/>:null}
      {selected ? (
        <CardDialog
          organizationId={organizationId}
          card={selected}
          readOnly={readOnly}
          onClose={() => setSelected(null)}
          onChanged={(card) => {
            setSelected(card)
            onReload()
          }}
        />
      ) : null}
    </div>
  )
}

