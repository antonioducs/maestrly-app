import { ExecutionConversation } from '../automations/ExecutionConversation.js'
import { CardAutomation } from '../automations/CardAutomation.js'
import { RunEvents } from '../automations/RunEvents.js'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { diffLines } from 'diff'
import { ArrowLeft, ChevronDown, Copy, MessageSquare, MoreHorizontal, Paperclip, Plus, X } from 'lucide-react'
import type { BoardColumn, Card } from '@maestrly/protocol'
import { t, useLocale, errorText, dateTime, number } from '../../i18n/index.js'
import { api, write } from '../../app/api.js'
import { Modal } from '../../components/Modal.js'
import { FormDialog } from '../../components/FormDialog.js'
import { Select } from '../../components/Select.js'
import { Markdown, MarkdownEditor } from '../../components/Markdown.js'
import { useDescriptionDraft } from './use-description-draft.js'
import { MemberPicker, initials, type Member } from './MemberPicker.js'

interface Detail {
  activeFamilyRuns?: number
  card: Card
  columnName: string
  userId: string
  canModerate: boolean
  parent: Card | null
  subtasks: Card[]
  comments: Array<{
    id: string
    body: string
    authorType: string
    authorId: string
    createdAt: string
    version: number
  }>
  attachments: Array<{ id: string; filename: string; sizeBytes: number }>
  executions: Array<{ jobId: string; jobState: string; personalDevice?:{name:string}|null; runState: string | null }>
  attempts: Array<{
    id: string
    jobId: string
    attempt: number
    state: string
    startedAt: string | null
    finishedAt: string | null
    outcome?: { summary?: string; failure?: string }
  }>
  requests: Array<{
    jobId: string
    approvalId: string | null
    approvalStatus: string | null
    informationRequestId: string | null
    question: string | null
  }>
  artifacts: Array<{ id: string; name: string; kind: string; orphaned: boolean }>
}
type Version = { id: string; body: string; version: number; actor: Record<string, string>; createdAt: string }
type EventItem = {
  reason?: string
  id: string
  type: string
  actor: Record<string, string>
  actorName?: string
  fromColumnName?: string
  toColumnName?: string
  data: Record<string, unknown>
  createdAt: string
}
const tabs = ['Details', 'Activity', 'Executions', 'History'] as const
type Tab = (typeof tabs)[number]
const RUN_TONES: Record<string, string> = {
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'muted',
  running: 'run',
  claimed: 'run',
  cancelling: 'run',
}
const runTone = (state: string | null | undefined) => (state ? (RUN_TONES[state] ?? 'muted') : 'muted')
const shortId = (id: string) => id.slice(0, 8)
const fileExt = (name: string) => (name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE')
const fileSize = (bytes: number) => (bytes >= 1048576 ? number(Math.round(bytes / 104857.6) / 10) + ' MiB' : number(Math.ceil(bytes / 1024)) + ' KiB')

export function CardDialog({
  organizationId,
  card,
  refreshToken,
  readOnly = false,
  onClose,
  onChanged,
}: {
  organizationId: string
  card: Card
  refreshToken?: unknown
  readOnly?: boolean
  onClose(): void
  onChanged(card: Card): void
}) {
  useLocale()
  // Subtasks and the parent open inside this same dialog; the trail drives the back breadcrumb.
  const [trail, setTrail] = useState<Card[]>([])
  const current = trail.at(-1) ?? card
  const [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState('')
  const request = useRef(0)
  const closeRef = useRef<() => void>(onClose)
  const reload = useCallback(async () => {
    const generation = ++request.current
    try {
      const data = await api<Detail>(`/api/v1/organizations/${organizationId}/cards/${current.id}`)
      if (generation !== request.current) return
      setDetail({
        ...data,
        subtasks: data.subtasks ?? [],
        attempts: data.attempts ?? [],
        requests: data.requests ?? [],
        columnName: data.columnName ?? '',
        userId: data.userId ?? '',
        canModerate: data.canModerate ?? false,
      })
      setError('')
    } catch (caught) {
      if (generation === request.current) setError(caught instanceof Error ? caught.message : 'Could not load this card.')
    }
  }, [organizationId, current.id])
  useEffect(() => {
    void reload()
    return () => { request.current++ }
  }, [reload, card.version, refreshToken])
  const ready = detail && detail.card.id === current.id
  return (
    <Modal title={ready ? detail.card.title : current.title} onClose={() => closeRef.current()} className="card-dialog">
      {ready ? (
        <CardEditor
          key={current.id}
          detail={detail}
          readOnly={readOnly}
          trail={trail}
          closeRef={closeRef}
          onClose={onClose}
          reload={reload}
          onChanged={(updated) => {
            // Nested cards keep the board focused on the card that was opened.
            if (trail.length) onChanged({ ...card })
            else onChanged(updated)
          }}
          onOpen={(next) => setTrail((items) => [...items, next])}
          onBack={trail.length ? () => setTrail((items) => items.slice(0, -1)) : undefined}
        />
      ) : (
        <div className="cd-loading">{error ? <p role="alert">{errorText(error)}</p> : <p>{t('Loading card…')}</p>}</div>
      )}
    </Modal>
  )
}

function CardEditor({
  detail,
  readOnly,
  trail,
  closeRef,
  onClose,
  onChanged,
  reload,
  onOpen,
  onBack,
}: {
  detail: Detail
  readOnly: boolean
  trail: Card[]
  closeRef: React.MutableRefObject<() => void>
  onClose(): void
  onChanged(card: Card): void
  reload(): Promise<void>
  onOpen(card: Card): void
  onBack?: () => void
}) {
  useLocale()
  const ids = useId()
  const [card, setCard] = useState(detail.card)
  useEffect(() => {
    setCard((current) => (detail.card.version > current.version ? detail.card : current))
  }, [detail.card])
  const changed = (updated: Card) => {
    setCard(updated)
    onChanged(updated)
  }
  const draft = useDescriptionDraft(card, detail.userId, changed, !readOnly && !card.archivedAt)
  const [tab, setTab] = useState<Tab>('Details')
  const [title, setTitle] = useState(card.title),
    [labels, setLabels] = useState(card.labels),
    [labelInput, setLabelInput] = useState('')
  const [priority, setPriority] = useState(card.priority),
    [criteria, setCriteria] = useState(card.acceptanceCriteria)
  const [assignees, setAssignees] = useState(card.assigneeUserIds),
    [members, setMembers] = useState<Member[]>([])
  const [columns, setColumns] = useState<BoardColumn[]>([])
  const metadataBase = useRef(card)
  const metadataDirty = title !== metadataBase.current.title || JSON.stringify(labels) !== JSON.stringify(metadataBase.current.labels) ||
    priority !== metadataBase.current.priority || JSON.stringify(criteria) !== JSON.stringify(metadataBase.current.acceptanceCriteria) ||
    JSON.stringify(assignees) !== JSON.stringify(metadataBase.current.assigneeUserIds) || !!labelInput.trim()
  useEffect(() => {
    if (metadataDirty) return
    metadataBase.current = card
    setTitle(card.title)
    setLabels(card.labels)
    setPriority(card.priority)
    setCriteria(card.acceptanceCriteria)
    setAssignees(card.assigneeUserIds)
  }, [card, metadataDirty])
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<'archive' | 'restore' | 'delete' | 'cancel' | null>(null)
  const [addingSubtask, setAddingSubtask] = useState(false)
  const [comment, setComment] = useState(''),
    [editingComment, setEditingComment] = useState<Detail['comments'][number] | null>(null)
  const [deletingComment, setDeletingComment] = useState<Detail['comments'][number] | null>(null)
  const [history, setHistory] = useState<Version[] | null>(null),
    [selectedVersion, setSelectedVersion] = useState<Version | null>(null)
  const [events, setEvents] = useState<EventItem[]>([]),
    [cursor, setCursor] = useState<number | null>(0),
    [feedFilter, setFeedFilter] = useState<'all' | 'comment' | 'event'>('all')
  const [answering, setAnswering] = useState<Detail['requests'][number] | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const locked = useRef(false)
  const base = `/api/v1/organizations/${card.organizationId}/cards/${card.id}`
  const canEdit = !readOnly && !card.archivedAt
  const canRequest = !readOnly && !card.archivedAt
  const active =
    !!detail.activeFamilyRuns ||
    detail.executions.some((e) => ['claimed', 'running', 'cancelling'].includes(e.runState ?? ''))
  useEffect(() => {
    void api<Member[]>(`/api/v1/organizations/${card.organizationId}/projects/${card.projectId}/members`)
      .then((items) => setMembers(Array.isArray(items) ? items : []))
      .catch(() => setMembers([]))
    void api<{ columns: BoardColumn[] }>(`/api/v1/organizations/${card.organizationId}/boards/${card.boardId}`)
      .then((board) => setColumns(board.columns ?? []))
      .catch(() => setColumns([]))
  }, [card.organizationId, card.projectId, card.boardId])
  const eventsRequest = useRef(0)
  useEffect(() => {
    let live = true
    if (tab === 'History')
      void api<Version[]>(base + '/history')
        .then((items) => { if (live) setHistory(items) })
        .catch((e) => setError(e.message))
    if (tab === 'Activity') void loadEvents(0)
    return () => { live = false; eventsRequest.current++ }
  }, [tab, base, detail, card.version])
  async function loadEvents(from: number) {
    const generation = ++eventsRequest.current
    try {
      const page = await api<{ items: EventItem[]; nextCursor: number | null }>(base + '/events?cursor=' + from)
      if (generation !== eventsRequest.current) return
      setEvents((current) => (from === 0 ? page.items : [...current, ...page.items]))
      setCursor(page.nextCursor)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load events.')
    }
  }
  async function action(fn: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await fn()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save. Please try again.')
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const pendingLabels = () => [...labels, ...labelInput.split(',').map((s) => s.trim()).filter(Boolean)].filter((v, i, a) => a.indexOf(v) === i)
  async function saveFields() {
    if (!title.trim()) throw new Error('Enter a card title.')
    if (!(await draft.flush())) return
    const latest = await api<Detail>(base)
    // If metadata changed, do not silently overwrite it.
    if (
      latest.card.title !== metadataBase.current.title ||
      JSON.stringify(latest.card.labels) !== JSON.stringify(metadataBase.current.labels) ||
      latest.card.priority !== metadataBase.current.priority ||
      JSON.stringify(latest.card.assigneeUserIds) !== JSON.stringify(metadataBase.current.assigneeUserIds) ||
      JSON.stringify(latest.card.acceptanceCriteria) !== JSON.stringify(metadataBase.current.acceptanceCriteria)
    )
      throw new Error('The card changed after it was loaded.')
    const updated = await write<Card>(base, 'PATCH', {
      expectedVersion: latest.card.version,
      title: title.trim(),
      labels: pendingLabels(),
      priority,
      acceptanceCriteria: criteria.map((s) => s.trim()).filter(Boolean),
      assigneeUserIds: assignees,
    })
    metadataBase.current = updated
    setLabelInput('')
    changed(updated)
    setNotice('Changes saved.')
  }
  async function close() {
    if (draft.status === 'dirty' || draft.status === 'saving') {
      if (!(await draft.flush())) return
    }
    // Failed/conflicting drafts remain in session storage and can be recovered on reopening.
    onClose()
  }
  closeRef.current = () => void close()
  async function attach(file: File) {
    if (file.size > 5 * 1024 * 1024) throw new Error('Attachment exceeds the 5 MiB limit.')
    const contentBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Attachment could not be read.'))
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
      reader.readAsDataURL(file)
    })
    await write(base + '/attachments', 'POST', {
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      contentBase64,
    })
    await reload()
    setNotice('Attachment added.')
  }
  async function moveTo(targetColumnId: string) {
    if (targetColumnId === card.columnId) return
    if (!(await draft.flush())) throw new Error('Resolve the description conflict before continuing.')
    const latest = await api<Detail>(base)
    const result = await write<{ card: Card }>(base + '/move', 'POST', {
      expectedVersion: latest.card.version,
      targetColumnId,
      targetPosition: 0,
      source: 'human',
    })
    metadataBase.current = result.card
    changed(result.card)
    await reload()
    setNotice('Card moved.')
  }
  function addLabelFromInput() {
    const next = pendingLabels()
    setLabels(next)
    setLabelInput('')
  }
  const columnOf = (id: string) => columns.find((c) => c.id === id)
  const doneSubtasks = detail.subtasks.filter((s) => columnOf(s.columnId)?.role === 'done').length
  const latestRun = detail.attempts[0]
  const execution = detail.executions[0]
  const executionState = latestRun?.state ?? execution?.runState ?? execution?.jobState ?? null
  const feed = useMemo(() => {
    const items = [
      ...detail.comments.map((item) => ({ kind: 'comment' as const, at: item.createdAt, comment: item })),
      ...events.map((item) => ({ kind: 'event' as const, at: item.createdAt, event: item })),
    ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    return feedFilter === 'all' ? items : items.filter((item) => item.kind === feedFilter)
  }, [detail.comments, events, feedFilter])
  const saveState =
    draft.status === 'conflict' || draft.status === 'error'
      ? { text: draft.status === 'conflict' ? 'Another edit was saved. Your draft is preserved.' : 'Save failed. Your draft is preserved.', tone: 'error' }
      : draft.status === 'saving'
        ? { text: 'Saving…', tone: 'warn' }
        : draft.status === 'dirty' || metadataDirty
          ? { text: 'Unsaved changes', tone: 'warn' }
          : notice
            ? { text: notice, tone: 'ok' }
            : { text: 'All changes saved', tone: 'ok' }
  const memberName = (id: string) => members.find((m) => m.id === id)?.name
  const copyId = () => {
    void navigator.clipboard?.writeText(card.id).then(() => setNotice('Card ID copied.')).catch(() => {})
  }
  const tabLabel = (item: Tab) =>
    item === 'Activity' ? detail.comments.length + events.length : item === 'Executions' ? detail.attempts.length : item === 'History' ? history?.length ?? null : null
  return (
    <>
      <div className="cd-head">
        <div className="cd-crumbs-row">
          <p className="cd-crumbs">
            {onBack ? (
              <button type="button" className="cd-back" onClick={onBack} aria-label={t('Back to {title}', { title: trail.at(-2)?.title ?? detail.parent?.title ?? '' })}>
                <ArrowLeft size={13} aria-hidden="true" />
              </button>
            ) : null}
            {detail.parent ? (
              <>
                <button type="button" className="cd-crumb-link" onClick={() => onOpen(detail.parent!)}>
                  {detail.parent.title}
                </button>
                <i aria-hidden="true">›</i>
              </>
            ) : null}
            <span>{detail.columnName || columnOf(card.columnId)?.name || t('Column')}</span>
            <i aria-hidden="true">›</i>
            <button type="button" className="cd-id" onClick={copyId} aria-label={t('Copy card ID')} title={card.id}>
              <code>#{shortId(card.id)}</code>
              <Copy size={11} aria-hidden="true" />
            </button>
          </p>
          <div className="cd-head-actions">
            <button
              type="button"
              className="quiet af-small"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('maestrly-open-project-chat', { detail: { organizationId: card.organizationId, projectId: card.projectId, boardId: card.boardId, cardId: card.id } }))
                void close()
              }}
            >
              <MessageSquare size={14} aria-hidden="true" />
              {t('Discuss this card')}
            </button>
            {!readOnly ? (
              <>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('More actions')}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-controls={ids + '-menu'}
                  onClick={() => {
                    if (menuOpen) menu.current?.hidePopover()
                    else {
                      menu.current?.showPopover()
                      const button = menu.current?.previousElementSibling as HTMLElement | null
                      const rect = button?.getBoundingClientRect()
                      if (menu.current && rect) {
                        menu.current.style.top = rect.bottom + 6 + 'px'
                        menu.current.style.left = Math.max(8, rect.right - 220) + 'px'
                      }
                    }
                  }}
                >
                  <MoreHorizontal size={18} />
                </button>
                <div
                  ref={menu}
                  id={ids + '-menu'}
                  popover="auto"
                  role="menu"
                  className="cd-menu"
                  onToggle={(event) => setMenuOpen(event.newState === 'open')}
                >
                  <button type="button" role="menuitem" disabled={busy} onClick={() => { menu.current?.hidePopover(); setConfirmation(card.archivedAt ? 'restore' : 'archive') }}>
                    {t(card.archivedAt ? 'Restore' : 'Archive')}
                  </button>
                  {active ? (
                    <button type="button" role="menuitem" className="danger" onClick={() => { menu.current?.hidePopover(); setConfirmation('cancel') }}>
                      {t('Cancel executions')}
                    </button>
                  ) : null}
                  <hr />
                  <button type="button" role="menuitem" className="danger" disabled={busy} onClick={() => { menu.current?.hidePopover(); setConfirmation('delete') }}>
                    {t('Delete card')}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
        <input
          className="cd-title"
          aria-label={t('Title')}
          value={title}
          maxLength={500}
          readOnly={!canEdit}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
        <div className="cd-meta">
          <span className={'cd-chip' + (card.archivedAt ? ' archived' : '')}>
            <i className="af-dot" />
            {t(card.archivedAt ? 'Archived' : 'Open')}
          </span>
          <span className={'cd-chip exec ' + runTone(executionState)}>
            <i className="af-dot" />
            {executionState ? t('Last execution') + ': ' + t(executionState) : t('No execution yet')}
          </span>
          {card.automationBlocked ? <span className="cd-chip dispatch-blocked">{t('Dispatch blocked')}</span> : null}
          {card.archivedAt && !readOnly ? (
            <button type="button" className="quiet af-small" disabled={busy} onClick={() => setConfirmation('restore')}>
              {t('Restore')}
            </button>
          ) : null}
          <div className="cd-save-slot">
            {canEdit && metadataDirty ? (
              <button type="button" className="primary af-small" disabled={busy || draft.status === 'conflict'} onClick={() => void action(saveFields)}>
                {t('Save changes')}
              </button>
            ) : null}
            {canEdit ? (
              <span className={'cd-save ' + saveState.tone} role="status">
                <i className="af-dot" />
                {t(saveState.text)}
              </span>
            ) : null}
          </div>
        </div>
        {error ? (
          <p className="form-error cd-error" role="alert">
            {errorText(error)}
          </p>
        ) : null}
        <nav className="cd-tabs" aria-label={t('Card details')} role="tablist">
          {tabs.map((item) => {
            const count = tabLabel(item)
            return (
              <button
                key={item}
                type="button"
                role="tab"
                id={'tab-' + item}
                aria-controls={'panel-' + item}
                aria-selected={tab === item}
                tabIndex={tab === item ? 0 : -1}
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
                  e.preventDefault()
                  const index = tabs.indexOf(item)
                  const next =
                    e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
                  setTab(next)
                  ;(e.currentTarget.parentElement?.querySelector('#tab-' + next) as HTMLElement | null)?.focus()
                }}
                onClick={() => setTab(item)}
              >
                {t(item)}
                {count !== null && count > 0 ? <small>{number(count)}</small> : null}
              </button>
            )
          })}
        </nav>
      </div>
      <div className="cd-body">
        <main className="cd-main">
          <div hidden={tab !== 'Details'} role="tabpanel" id="panel-Details" aria-labelledby="tab-Details">
            <section className="cd-block">
              <header className="cd-block-head">
                <h3>{t('Description')}</h3>
              </header>
              {canEdit ? (
                <MarkdownEditor label={t('Description')} value={draft.description} onChange={draft.edit} resetKey={draft.revision} rich />
              ) : (
                <Markdown value={card.description} />
              )}
              {draft.status === 'error' || draft.status === 'conflict' ? (
                <div className="conflict-box">
                  <p role="alert">{errorText(draft.error)}</p>
                  {draft.remote ? (
                    <>
                      <p>{t('Server version')}</p>
                      <Markdown value={draft.remote.description} />
                      <button type="button" className="quiet" onClick={draft.useServer}>
                        {t('Use server version')}
                      </button>
                      <button type="button" className="primary" onClick={draft.keepMine}>
                        {t('Save my draft over this version')}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="quiet" onClick={() => void draft.flush()}>
                      {t('Retry save')}
                    </button>
                  )}
                </div>
              ) : null}
            </section>
            <section className="cd-block">
              <header className="cd-block-head">
                <h3>
                  {t('Acceptance criteria')}
                  {criteria.length ? <small>{number(criteria.length)}</small> : null}
                </h3>
                {canEdit ? (
                  <button type="button" className="quiet af-small" onClick={() => setCriteria([...criteria, ''])}>
                    <Plus size={13} aria-hidden="true" />
                    {t('Add criterion')}
                  </button>
                ) : null}
              </header>
              {criteria.length ? (
                <ol className="cd-criteria">
                  {criteria.map((item, index) => (
                    <li key={index}>
                      <span className="cd-criteria-mark" aria-hidden="true" />
                      {canEdit ? (
                        <input
                          aria-label={t('Criterion {n}', { n: String(index + 1) })}
                          value={item}
                          autoFocus={item === '' && index === criteria.length - 1}
                          placeholder={t('Describe what must be true when this card is done')}
                          onChange={(e) => setCriteria(criteria.map((c, i) => (i === index ? e.target.value : c)))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); setCriteria([...criteria.slice(0, index + 1), '', ...criteria.slice(index + 1)]) }
                            if (e.key === 'Backspace' && !item && criteria.length > 1) { e.preventDefault(); setCriteria(criteria.filter((_, i) => i !== index)) }
                          }}
                        />
                      ) : (
                        <span>{item}</span>
                      )}
                      {canEdit ? (
                        <button type="button" className="cd-remove" aria-label={t('Remove criterion')} onClick={() => setCriteria(criteria.filter((_, i) => i !== index))}>
                          <X size={13} aria-hidden="true" />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="cd-empty">{t('No acceptance criteria yet.')}</p>
              )}
            </section>
            <section className="cd-block">
              <header className="cd-block-head">
                <h3>
                  {t('Subtasks')}
                  {detail.subtasks.length ? <small>{number(doneSubtasks)}/{number(detail.subtasks.length)}</small> : null}
                </h3>
                {canEdit && !card.parentCardId ? (
                  <button type="button" className="quiet af-small" onClick={() => setAddingSubtask(true)}>
                    <Plus size={13} aria-hidden="true" />
                    {t('Add subtask')}
                  </button>
                ) : null}
              </header>
              {detail.subtasks.length ? (
                <>
                  <div className="cd-progress" aria-hidden="true">
                    <i style={{ width: Math.round((doneSubtasks / detail.subtasks.length) * 100) + '%' }} />
                  </div>
                  <ul className="cd-subtasks">
                    {detail.subtasks.map((child) => {
                      const column = columnOf(child.columnId)
                      return (
                        <li key={child.id}>
                          <button type="button" className="cd-subtask" onClick={() => onOpen(child)}>
                            <code>#{shortId(child.id)}</code>
                            <span>{child.title}</span>
                            <em className={'cd-pill ' + (child.archivedAt ? 'muted' : column?.role === 'done' ? 'done' : column?.role === 'backlog' ? 'muted' : '')}>
                              {child.archivedAt ? t('Archived') : column?.name ?? t('Open')}
                            </em>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </>
              ) : (
                <p className="cd-empty">{t('No subtasks yet.')}</p>
              )}
            </section>
            <section className="cd-block">
              <header className="cd-block-head">
                <h3>
                  {t('Attachments')}
                  {detail.attachments.length ? <small>{number(detail.attachments.length)}</small> : null}
                </h3>
                {canEdit ? (
                  <label className="quiet af-small attachment-button">
                    <Paperclip size={13} aria-hidden="true" />
                    {t('Add attachment')}
                    <input
                      className="sr-only"
                      type="file"
                      disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void action(() => attach(file))
                        e.target.value = ''
                      }}
                    />
                  </label>
                ) : null}
              </header>
              {detail.attachments.length ? (
                <div className="cd-attachments">
                  {detail.attachments.map((file) => (
                    <a
                      className="cd-attachment"
                      key={file.id}
                      href={`/api/v1/organizations/${card.organizationId}/attachments/${file.id}/download?protocolVersion=1.0`}
                    >
                      <i>{fileExt(file.filename)}</i>
                      <span>{file.filename}</span>
                      <small>{fileSize(file.sizeBytes)}</small>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="cd-empty">{t('No attachments yet.')}</p>
              )}
            </section>
          </div>
          <div hidden={tab !== 'Activity'} role="tabpanel" id="panel-Activity" aria-labelledby="tab-Activity">
            <div className="cd-feed-filter">
              <div className="af-seg cd-seg" role="radiogroup" aria-label={t('Activity filter')}>
                {(['all', 'comment', 'event'] as const).map((value) => (
                  <button key={value} type="button" role="radio" aria-checked={feedFilter === value} onClick={() => setFeedFilter(value)}>
                    {t(value === 'all' ? 'Everything' : value === 'comment' ? 'Comments' : 'Events')}
                  </button>
                ))}
              </div>
            </div>
            <ol className="cd-feed">
              {feed.map((item) =>
                item.kind === 'comment' ? (
                  <li className="comment-entry" key={'c-' + item.comment.id}>
                    <i className="member-avatar" aria-hidden="true">
                      {item.comment.authorType === 'agent' ? 'AI' : initials(memberName(item.comment.authorId) ?? '?')}
                    </i>
                    <div>
                      <header>
                        <strong>{item.comment.authorType === 'agent' ? t('Agent') : (memberName(item.comment.authorId) ?? t('Teammate'))}</strong>
                        <time>{dateTime(item.comment.createdAt)}</time>
                      </header>
                      <blockquote>
                        <Markdown value={item.comment.body} />
                      </blockquote>
                      {canEdit && (detail.canModerate || (item.comment.authorType === 'human' && item.comment.authorId === detail.userId)) ? (
                        <div className="inline-actions">
                          <button type="button" onClick={() => { setEditingComment(item.comment); setComment(item.comment.body) }}>
                            {t('Edit')}
                          </button>
                          <button type="button" onClick={() => setDeletingComment(item.comment)}>{t('Delete')}</button>
                        </div>
                      ) : null}
                    </div>
                  </li>
                ) : (
                  <li className="timeline-entry" key={'e-' + item.event.id}>
                    <i className="member-avatar sys" aria-hidden="true" />
                    <div>
                      <header>
                        <strong>{t(item.event.type)}</strong>
                        <time>{dateTime(item.event.createdAt)}</time>
                      </header>
                      <p>
                        {item.event.actorName ?? item.event.actor.userId ?? item.event.actor.type}
                        {item.event.data.fromColumnId || item.event.data.toColumnId ? (
                          <>
                            {' · '}
                            <em className="cd-pill muted">{item.event.fromColumnName ?? t('Column')}</em> → <em className="cd-pill">{item.event.toColumnName ?? t('Column')}</em>
                          </>
                        ) : null}
                      </p>
                      {item.event.reason ? <p>{item.event.reason}</p> : null}
                    </div>
                  </li>
                )
              )}
            </ol>
            {!feed.length ? <p className="cd-empty">{t(feedFilter === 'comment' ? 'No comments yet.' : feedFilter === 'event' ? 'No events yet.' : 'No activity yet.')}</p> : null}
            {cursor !== null && feedFilter !== 'comment' ? (
              <button type="button" className="quiet af-small" onClick={() => void loadEvents(cursor)}>
                {t('Load more')}
              </button>
            ) : null}
            {canEdit ? (
              <section className="cd-composer">
                <i className="member-avatar" aria-hidden="true">
                  {initials(memberName(detail.userId) ?? '')}
                </i>
                <div>
                  <MarkdownEditor label={t('Comment')} value={comment} onChange={setComment} />
                  <div className="cd-composer-actions">
                    <span className="cd-hint">{t(editingComment ? 'Editing comment' : 'Markdown is supported.')}</span>
                    <div className="dialog-actions">
                      {editingComment ? (
                        <button type="button" className="quiet af-small" onClick={() => { setEditingComment(null); setComment('') }}>
                          {t('Cancel')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="primary af-small"
                        disabled={busy || !comment.trim()}
                        onClick={() =>
                          void action(async () => {
                            await write(
                              editingComment ? base + '/comments/' + editingComment.id : base + '/comments',
                              editingComment ? 'PATCH' : 'POST',
                              { body: comment.trim(), ...(editingComment ? { expectedVersion: editingComment.version } : {}) }
                            )
                            setComment('')
                            setEditingComment(null)
                            await reload()
                          })
                        }
                      >
                        {t(editingComment ? 'Save comment' : 'Comment')}
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            ) : null}
          </div>
          <div hidden={tab !== 'Executions'} role="tabpanel" id="panel-Executions" aria-labelledby="tab-Executions">
            {latestRun ? (
              <div className={'cd-exec-hero ' + runTone(latestRun.state)}>
                <div>
                  <p className="cd-exec-title">
                    <i className="af-dot" />
                    {t('Attempt')} {number(latestRun.attempt)} · {t(latestRun.state)}
                  </p>
                  <p className="cd-exec-sub">
                    {execution?.personalDevice ? t('Personal execution') + ' · ' + execution.personalDevice.name + ' · ' : ''}
                    {latestRun.startedAt ? dateTime(latestRun.startedAt) : ''}
                    {latestRun.finishedAt ? ' → ' + dateTime(latestRun.finishedAt) : ''}
                  </p>
                </div>
              </div>
            ) : (
              <p className="cd-empty">{t('No execution yet')}</p>
            )}
            {latestRun?.outcome?.summary || latestRun?.outcome?.failure ? (
              <div className="cd-exec-summary">
                <Markdown value={latestRun.outcome?.summary ?? latestRun.outcome?.failure ?? ''} />
              </div>
            ) : null}
            {detail.requests.map((request) => (
              <section key={request.jobId} className="cd-block cd-request">
                {request.approvalId && canRequest ? (
                  <div className="dialog-actions">
                    <span className="cd-hint">{t('This job waits for approval.')}</span>
                    {(['approved', 'rejected'] as const).map((decision) => (
                      <button
                        type="button"
                        className="quiet"
                        disabled={busy}
                        key={decision}
                        onClick={() =>
                          void action(async () => {
                            await write(
                              `/api/v1/organizations/${card.organizationId}/projects/${card.projectId}/approvals/${request.approvalId}`,
                              'POST',
                              { decision }
                            )
                            await reload()
                          })
                        }
                      >
                        {t(decision === 'approved' ? 'Approve' : 'Reject')}
                      </button>
                    ))}
                  </div>
                ) : null}
                {request.informationRequestId ? (
                  <>
                    <Markdown value={request.question ?? ''} />
                    {canRequest ? (
                      <button type="button" className="primary" onClick={() => setAnswering(request)}>
                        {t('Answer agent')}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </section>
            ))}
            {tab === 'Executions' ? <CardAutomation card={card} readOnly={readOnly} beforeRun={draft.flush} onChanged={() => { void reload() }} /> : null}
            {detail.attempts.length ? (
              <section className="cd-block">
                <header className="cd-block-head">
                  <h3>
                    {t('Attempts')}
                    <small>{number(detail.attempts.length)}</small>
                  </h3>
                </header>
                {detail.attempts.map((run, index) => (
                  <details className="cd-run" key={run.id} open={index === 0}>
                    <summary>
                      <i className={'af-dot ' + runTone(run.state)} />
                      <span>
                        {t('Attempt')} {number(run.attempt)}
                      </span>
                      <em>{t(run.state)}</em>
                      {run.startedAt ? <time>{dateTime(run.startedAt)}</time> : null}
                      <ChevronDown size={14} aria-hidden="true" />
                    </summary>
                    <div className="cd-run-body">
                      {index > 0 ? <Markdown value={run.outcome?.summary ?? run.outcome?.failure ?? ''} /> : null}
                      <ExecutionConversation organizationId={card.organizationId} cardId={card.id} runId={run.id} />
                      <RunEvents organizationId={card.organizationId} cardId={card.id} runId={run.id} />
                    </div>
                  </details>
                ))}
              </section>
            ) : null}
            {detail.artifacts.length ? (
              <section className="cd-block">
                <header className="cd-block-head">
                  <h3>{t('Evidence')}</h3>
                </header>
                <div className="cd-artifacts">
                  {detail.artifacts.map((item) => (
                    <a key={item.id} href={`/api/v1/organizations/${card.organizationId}/artifacts/${item.id}/download?protocolVersion=1.0`}>
                      {t(item.orphaned ? 'Orphaned evidence' : item.kind)} · {item.name}
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
          <div hidden={tab !== 'History'} role="tabpanel" id="panel-History" aria-labelledby="tab-History">
            <p className="cd-note">{t('Restoring creates a new version. Your current version stays in history.')}</p>
            <div className="history-list">
              {(history ?? []).map((version) => (
                <button
                  key={version.id}
                  type="button"
                  className="quiet"
                  aria-pressed={selectedVersion?.id === version.id}
                  onClick={() => setSelectedVersion(version)}
                >
                  {t('Version')} {number(version.version)} · {dateTime(version.createdAt)}
                </button>
              ))}
            </div>
            {history && !history.length ? <p className="cd-empty">{t('No description history yet.')}</p> : null}
            {selectedVersion ? (
              <>
                <div className="markdown-diff">
                  {diffLines(card.description, selectedVersion.body).map((part, index) => (
                    <pre key={index} className={part.added ? 'added' : part.removed ? 'removed' : ''}>
                      {part.value}
                    </pre>
                  ))}
                </div>
                {canEdit ? (
                  <div className="dialog-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          if (!(await draft.flush())) return
                          const latest = await api<Detail>(base)
                          const updated = await write<Card>(base + '/history/restore', 'POST', {
                            expectedVersion: latest.card.version,
                            versionId: selectedVersion.id,
                          })
                          draft.replace(updated)
                          setSelectedVersion(null)
                          await reload()
                        })
                      }
                    >
                      {t('Restore version')}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </main>
        <aside className="cd-side">
          <section className="cd-side-block">
            <h4>{t('Properties')}</h4>
            <div className="cd-prop">
              <span className="cd-prop-label" id={ids + '-column'}>{t('Column')}</span>
              <Select
                label={t('Column')}
                value={card.columnId}
                disabled={!canEdit || busy || !columns.length}
                onChange={(id) => void action(() => moveTo(id))}
                options={columns.length ? columns.map((c) => ({ value: c.id, label: c.name })) : [{ value: card.columnId, label: detail.columnName || t('Column') }]}
              />
            </div>
            <div className={'cd-prop cd-priority cd-prio-' + priority}>
              <span className="cd-prop-label">{t('Priority')}</span>
              <Select
                label={t('Priority')}
                value={priority}
                disabled={!canEdit}
                onChange={(v) => setPriority(v as Card['priority'])}
                options={['none', 'low', 'medium', 'high', 'urgent'].map((value) => ({ value, label: t(value) }))}
              />
            </div>
            <div className="cd-prop">
              <span className="cd-prop-label">{t('Labels')}</span>
              <div className="cd-labels">
                {labels.map((label) => (
                  <span className="cd-tag" key={label}>
                    {label}
                    {canEdit ? (
                      <button type="button" aria-label={t('Remove {name}', { name: label })} onClick={() => setLabels(labels.filter((l) => l !== label))}>
                        <X size={11} aria-hidden="true" />
                      </button>
                    ) : null}
                  </span>
                ))}
                {canEdit ? (
                  <input
                    className="cd-label-input"
                    aria-label={t('Labels')}
                    placeholder={t('Add label')}
                    value={labelInput}
                    onChange={(e) => setLabelInput(e.target.value)}
                    onBlur={() => { if (labelInput.trim()) addLabelFromInput() }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addLabelFromInput() }
                      if (e.key === 'Backspace' && !labelInput && labels.length) setLabels(labels.slice(0, -1))
                    }}
                  />
                ) : null}
                {!labels.length && !canEdit ? <span className="cd-empty">{t('No labels')}</span> : null}
              </div>
            </div>
            <div className="cd-prop">
              <span className="cd-prop-label">{t('Assignees')}</span>
              <MemberPicker members={members} selected={assignees} onChange={setAssignees} disabled={!canEdit} label={t('Assignees')} />
            </div>
          </section>
          <section className="cd-side-block cd-agent">
            <h4>{t('Column agent')}</h4>
            <p className="cd-agent-line">
              <i className={'af-dot ' + runTone(executionState)} />
              <b>{executionState ? t(executionState) : t('No execution yet')}</b>
              {latestRun ? <span> · {t('Attempt')} {number(latestRun.attempt)}</span> : null}
            </p>
            {latestRun?.startedAt ? <p className="cd-agent-sub">{dateTime(latestRun.startedAt)}</p> : null}
            {card.automationBlocked ? <p className="cd-agent-warn">{t('Dispatch limit reached. Release this card to continue.')}</p> : null}
            <div className="cd-agent-actions">
              <button type="button" className="quiet af-small" onClick={() => setTab('Executions')}>
                {t('View executions')}
              </button>
            </div>
          </section>
          <section className="cd-side-block cd-meta-block">
            <dl>
              <dt>ID</dt>
              <dd>
                <code>{card.id}</code>
              </dd>
              <dt>{t('Created')}</dt>
              <dd>{dateTime(card.createdAt)}</dd>
              <dt>{t('Updated')}</dt>
              <dd>{dateTime(card.updatedAt)}</dd>
              <dt>{t('Version')}</dt>
              <dd>{number(card.version)}</dd>
            </dl>
          </section>
        </aside>
      </div>
      {confirmation ? (
        <FormDialog
          title={t(
            confirmation === 'delete'
              ? 'Delete card'
              : confirmation === 'cancel'
                ? 'Cancel executions'
                : confirmation === 'archive'
                  ? 'Archive card'
                  : 'Restore card'
          )}
          submitLabel={t('Confirm')}
          onClose={() => setConfirmation(null)}
          onSubmit={async () => {
            if (!(await draft.flush())) throw new Error('Resolve the description conflict before continuing.')
            const latest = await api<Detail>(base)
            await write(base + '/lifecycle', 'POST', { expectedVersion: latest.card.version, action: confirmation })
            if (confirmation === 'cancel') {
              await reload()
            } else {
              onChanged({
                ...latest.card,
                version: latest.card.version + 1,
                archivedAt: confirmation === 'restore' ? null : new Date().toISOString(),
              })
              onClose()
            }
          }}
        >
          <p>{card.title}</p>
          <p>
            {t('This action also affects the subtasks.')} {number(detail.subtasks.length)}
          </p>
          {confirmation === 'delete' ? (
            <p>{t('The card will be removed. Audit history and execution evidence are retained.')}</p>
          ) : null}
          {active && confirmation !== 'cancel' ? (
            <p className="form-error">{t('Cancel active executions before removing this card.')}</p>
          ) : null}
        </FormDialog>
      ) : null}
      {addingSubtask ? (
        <FormDialog
          title={t('Add subtask')}
          submitLabel={t('Create card')}
          onClose={() => setAddingSubtask(false)}
          onSubmit={async (data) => {
            const title = String(data.get('title') ?? '').trim()
            if (!title) throw new Error('Enter a card title.')
            await write(`/api/v1/organizations/${card.organizationId}/boards/${card.boardId}/cards`, 'POST', {
              title,
              parentCardId: card.id,
              columnId: card.columnId,
            })
            await reload()
            onChanged(card)
          }}
        >
          <label>
            {t('Title')}
            <input name="title" required maxLength={500} />
          </label>
        </FormDialog>
      ) : null}
      {deletingComment ? (
        <FormDialog
          title={t('Delete comment')}
          submitLabel={t('Delete')}
          onClose={() => setDeletingComment(null)}
          onSubmit={async () => {
            await write(base + '/comments/' + deletingComment.id, 'PATCH', {
              expectedVersion: deletingComment.version,
              deleted: true,
            })
            await reload()
          }}
        >
          <Markdown value={deletingComment.body} />
        </FormDialog>
      ) : null}
      {answering ? (
        <FormDialog
          title={t('Answer agent')}
          submitLabel={t('Send response')}
          onClose={() => setAnswering(null)}
          onSubmit={async (data) => {
            const response = String(data.get('response') ?? '').trim()
            if (!response) throw new Error('Enter a response for the agent.')
            await write(
              `/api/v1/organizations/${card.organizationId}/projects/${card.projectId}/information-requests/${answering.informationRequestId}`,
              'POST',
              { response }
            )
            await reload()
          }}
        >
          <Markdown value={answering.question ?? ''} />
          <label>
            {t('Your response')}
            <textarea name="response" required rows={5} />
          </label>
        </FormDialog>
      ) : null}
    </>
  )
}
