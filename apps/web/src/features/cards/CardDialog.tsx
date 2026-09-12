import { ExecutionConversation } from '../automations/ExecutionConversation.js'
import { CardAutomation } from '../automations/CardAutomation.js'
import { RunEvents } from '../automations/RunEvents.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { diffLines } from 'diff'
import type { Card } from '@maestrly/protocol'
import { t, useLocale, errorText, dateTime, number } from '../../i18n/index.js'
import { api, write } from '../../app/api.js'
import { Modal } from '../../components/Modal.js'
import { FormDialog } from '../../components/FormDialog.js'
import { Select } from '../../components/Select.js'
import { Markdown, MarkdownEditor } from '../../components/Markdown.js'
import { useDescriptionDraft } from './use-description-draft.js'

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
const tabs = ['General', 'Events', 'Comments', 'History', 'Executions'] as const

export function CardDialog({
  organizationId,
  card,
  readOnly = false,
  onClose,
  onChanged,
}: {
  organizationId: string
  card: Card
  readOnly?: boolean
  onClose(): void
  onChanged(card: Card): void
}) {
  useLocale()
  const [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState('')
  const reload = useCallback(async () => {
    try {
      const data = await api<Detail>(`/api/v1/organizations/${organizationId}/cards/${card.id}`)
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
      setError(caught instanceof Error ? caught.message : 'Could not load this card.')
    }
  }, [organizationId, card.id])
  useEffect(() => {
    void reload()
  }, [reload, card.version])
  if (!detail || detail.card.id !== card.id)
    return (
      <Modal title={card.title} onClose={onClose} wide>
        {error ? <p role="alert">{errorText(error)}</p> : <p>{t('Loading card…')}</p>}
      </Modal>
    )
  return (
    <CardEditor
      key={card.id}
      detail={detail}
      readOnly={readOnly}
      onClose={onClose}
      onChanged={onChanged}
      reload={reload}
    />
  )
}

function CardEditor({
  detail,
  readOnly,
  onClose,
  onChanged,
  reload,
}: {
  detail: Detail
  readOnly: boolean
  onClose(): void
  onChanged(card: Card): void
  reload(): Promise<void>
}) {
  useLocale()
  const [card, setCard] = useState(detail.card)
  useEffect(() => {
    setCard((current) => (detail.card.version > current.version ? detail.card : current))
  }, [detail.card])
  const changed = (updated: Card) => {
    setCard(updated)
    onChanged(updated)
  }
  const draft = useDescriptionDraft(card, detail.userId, changed, !readOnly && !card.archivedAt)
  const [tab, setTab] = useState<(typeof tabs)[number]>('General')
  const [title, setTitle] = useState(card.title),
    [labels, setLabels] = useState(card.labels.join(', '))
  const [priority, setPriority] = useState(card.priority),
    [criteria, setCriteria] = useState(card.acceptanceCriteria.join('\n'))
  const [assignees, setAssignees] = useState(card.assigneeUserIds),
    [members, setMembers] = useState<Array<{ id: string; name: string }>>([])
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<'archive' | 'restore' | 'delete' | 'cancel' | null>(null)
  const [addingSubtask, setAddingSubtask] = useState(false),
    [nested, setNested] = useState<Card | null>(null)
  const [comment, setComment] = useState(''),
    [editingComment, setEditingComment] = useState<Detail['comments'][number] | null>(null)
  const [deletingComment, setDeletingComment] = useState<Detail['comments'][number] | null>(null)
  const [history, setHistory] = useState<Version[]>([]),
    [selectedVersion, setSelectedVersion] = useState<Version | null>(null)
  const [events, setEvents] = useState<EventItem[]>([]),
    [cursor, setCursor] = useState<number | null>(0)
  const [answering, setAnswering] = useState<Detail['requests'][number] | null>(null)
  const locked = useRef(false)
  const base = `/api/v1/organizations/${card.organizationId}/cards/${card.id}`
  const canEdit = !readOnly && !card.archivedAt
  const canRequest = !readOnly && !card.archivedAt
  const active =
    !!detail.activeFamilyRuns ||
    detail.executions.some((e) => ['claimed', 'running', 'cancelling'].includes(e.runState ?? ''))
  useEffect(() => {
    void api<Array<{ id: string; name: string }>>(
      `/api/v1/organizations/${card.organizationId}/projects/${card.projectId}/members`
    )
      .then(setMembers)
      .catch(() => setMembers([]))
  }, [card.organizationId, card.projectId])
  useEffect(() => {
    if (tab === 'History')
      void api<Version[]>(base + '/history')
        .then(setHistory)
        .catch((e) => setError(e.message))
    if (tab === 'Events') void loadEvents(0)
  }, [tab, base, card.version])
  async function loadEvents(from: number) {
    try {
      const page = await api<{ items: EventItem[]; nextCursor: number | null }>(base + '/events?cursor=' + from)
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
  async function saveFields() {
    if (!title.trim()) throw new Error('Enter a card title.')
    if (!(await draft.flush())) return
    const latest = await api<Detail>(base)
    // If metadata changed, do not silently overwrite it.
    if (
      latest.card.title !== card.title ||
      JSON.stringify(latest.card.labels) !== JSON.stringify(card.labels) ||
      latest.card.priority !== card.priority ||
      JSON.stringify(latest.card.assigneeUserIds) !== JSON.stringify(card.assigneeUserIds) ||
      JSON.stringify(latest.card.acceptanceCriteria) !== JSON.stringify(card.acceptanceCriteria)
    )
      throw new Error('The card changed after it was loaded.')
    const updated = await write<Card>(base, 'PATCH', {
      expectedVersion: latest.card.version,
      title: title.trim(),
      labels: labels
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      priority,
      acceptanceCriteria: criteria
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      assigneeUserIds: assignees,
    })
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
  return (
    <Modal title={card.title} onClose={() => void close()} wide>
      <div className="card-context">
        <button className="quiet" onClick={()=>{window.dispatchEvent(new CustomEvent('maestrly-open-project-chat',{detail:{organizationId:card.organizationId,projectId:card.projectId,boardId:card.boardId,cardId:card.id}}));void close()}}>{t('Discuss this card')}</button>
        {card.automationBlocked?<span className="dispatch-blocked">{t('Dispatch blocked')}</span>:null}
        <span>{detail.columnName}</span>
        <span>{t(card.archivedAt ? 'Archived' : 'Open')}</span>
        <span>
          {t('Execution status')}:{' '}
          {t(detail.executions[0]?.runState ?? detail.executions[0]?.jobState ?? 'No execution')}
        </span>
      </div>
      {detail.parent ? (
        <button className="quiet" onClick={() => setNested(detail.parent)}>
          {t('Parent card')}: {detail.parent.title}
        </button>
      ) : null}
      <nav className="detail-tabs segmented" aria-label={t('Card details')} role="tablist">
        {tabs.map((item) => (
          <button
            key={item}
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
                e.key === 'Home'
                  ? tabs[0]
                  : e.key === 'End'
                    ? tabs[tabs.length - 1]
                    : tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
              setTab(next)
              ;(e.currentTarget.parentElement?.querySelector('#tab-' + next) as HTMLElement | null)?.focus()
            }}
            onClick={() => setTab(item)}
          >
            {t(item)}
            {item === 'Comments' ? <small>{number(detail.comments.length)}</small> : null}
          </button>
        ))}
      </nav>
      <div hidden={tab !== 'General'} role="tabpanel" id="panel-General" aria-labelledby="tab-General">
        <label>
          {t('Title')}
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} readOnly={!canEdit} />
        </label>
        <div className="field-grid">
          <div className="select-field">
            {t('Priority')}
            <Select
              label={t('Priority')}
              value={priority}
              disabled={!canEdit}
              onChange={(v) => setPriority(v as Card['priority'])}
              options={['none', 'low', 'medium', 'high', 'urgent'].map((value) => ({ value, label: t(value) }))}
            />
          </div>
          <label>
            {t('Labels')}
            <input
              value={labels}
              readOnly={!canEdit}
              onChange={(e) => setLabels(e.target.value)}
              placeholder={t('Separate labels with commas')}
            />
          </label>
        </div>
        <p className="field-title">{t('Description')}</p>
        {canEdit ? (
          <MarkdownEditor
            label={t('Description')}
            value={draft.description}
            onChange={draft.edit}
            resetKey={draft.revision}
            rich
          />
        ) : (
          <Markdown value={card.description} />
        )}
        {canEdit ? (
          <div className="save-state" role="status">
            {t(
              {
                saved: 'All changes saved',
                dirty: 'Unsaved changes',
                saving: 'Saving…',
                error: 'Save failed. Your draft is preserved.',
                conflict: 'Another edit was saved. Your draft is preserved.',
              }[draft.status]
            )}
          </div>
        ) : null}
        {draft.status === 'error' || draft.status === 'conflict' ? (
          <div className="conflict-box">
            <p role="alert">{errorText(draft.error)}</p>
            {draft.remote ? (
              <>
                <p>{t('Server version')}</p>
                <Markdown value={draft.remote.description} />
                <button className="quiet" onClick={draft.useServer}>
                  {t('Use server version')}
                </button>
                <button className="primary" onClick={draft.keepMine}>
                  {t('Save my draft over this version')}
                </button>
              </>
            ) : (
              <button className="quiet" onClick={() => void draft.flush()}>
                {t('Retry save')}
              </button>
            )}
          </div>
        ) : null}
        <label>
          {t('Acceptance criteria')}
          <textarea
            rows={3}
            value={criteria}
            readOnly={!canEdit}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder={t('One criterion per line')}
          />
        </label>
        <fieldset className="member-picker" disabled={!canEdit}>
          <legend>{t('Assignees')}</legend>
          {members.map((member) => (
            <label key={member.id}>
              <input
                type="checkbox"
                checked={assignees.includes(member.id)}
                onChange={(e) =>
                  setAssignees(
                    e.target.checked ? [...assignees, member.id] : assignees.filter((id) => id !== member.id)
                  )
                }
              />
              {member.name}
            </label>
          ))}
        </fieldset>
        {canEdit ? (
          <div className="dialog-actions">
            <button
              className="primary"
              disabled={busy || draft.status === 'conflict'}
              onClick={() => void action(saveFields)}
            >
              {t('Save changes')}
            </button>
          </div>
        ) : null}
        <section className="card-section">
          <header>
            <h3>{t('Subtasks')}</h3>
            {canEdit && !card.parentCardId ? (
              <button className="quiet" onClick={() => setAddingSubtask(true)}>
                {t('Add subtask')}
              </button>
            ) : null}
          </header>
          {detail.subtasks.length ? (
            detail.subtasks.map((child) => (
              <button key={child.id} className="subtask-row" onClick={() => setNested(child)}>
                <span>{child.title}</span>
                <small>{t(child.archivedAt ? 'Archived' : 'Open')}</small>
              </button>
            ))
          ) : (
            <p className="form-note">{t('No subtasks yet.')}</p>
          )}
        </section>
        <section className="card-section">
          <h3>{t('Attachments')}</h3>
          {detail.attachments.map((file) => (
            <a
              className="attachment-row"
              key={file.id}
              href={`/api/v1/organizations/${card.organizationId}/attachments/${file.id}/download?protocolVersion=1.0`}
            >
              {file.filename} · {number(Math.ceil(file.sizeBytes / 1024))} KiB
            </a>
          ))}
          {canEdit ? (
            <label className="quiet attachment-button">
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
        </section>
      </div>
      <div hidden={tab !== 'Comments'} role="tabpanel" id="panel-Comments" aria-labelledby="tab-Comments">
        {detail.comments.length ? (
          detail.comments.map((item) => (
            <article className="comment-entry" key={item.id}>
              <header>
                <strong>
                  {item.authorType === 'agent'
                    ? t('Agent')
                    : (members.find((m) => m.id === item.authorId)?.name ?? t('Teammate'))}
                </strong>
                <time>{dateTime(item.createdAt)}</time>
              </header>
              <Markdown value={item.body} />
              {canEdit && (detail.canModerate || (item.authorType === 'human' && item.authorId === detail.userId)) ? (
                <div className="inline-actions">
                  <button
                    onClick={() => {
                      setEditingComment(item)
                      setComment(item.body)
                    }}
                  >
                    {t('Edit')}
                  </button>
                  <button onClick={() => setDeletingComment(item)}>{t('Delete')}</button>
                </div>
              ) : null}
            </article>
          ))
        ) : (
          <p>{t('No comments yet.')}</p>
        )}
        {canEdit ? (
          <section className="card-section">
            <h3>{t(editingComment ? 'Edit comment' : 'Add comment')}</h3>
            <MarkdownEditor label={t('Comment')} value={comment} onChange={setComment} />
            <div className="dialog-actions">
              {editingComment ? (
                <button
                  className="quiet"
                  onClick={() => {
                    setEditingComment(null)
                    setComment('')
                  }}
                >
                  {t('Cancel')}
                </button>
              ) : null}
              <button
                className="primary"
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
          </section>
        ) : null}
      </div>
      <div hidden={tab !== 'Events'} role="tabpanel" id="panel-Events" aria-labelledby="tab-Events">
        {events.map((event) => (
          <article className="timeline-entry" key={event.id}>
            <header>
              <strong>{t(event.type)}</strong>
              <time>{dateTime(event.createdAt)}</time>
            </header>
            <p>{event.actorName ?? event.actor.userId ?? event.actor.type}</p>
            {event.data.fromColumnId || event.data.toColumnId ? (
              <p className="form-note">
                {event.fromColumnName ?? t('Column')} → {event.toColumnName ?? t('Column')}
              </p>
            ) : null}
            {event.reason ? <p>{event.reason}</p> : null}
          </article>
        ))}
        {!events.length ? <p>{t('No events yet.')}</p> : null}
        {cursor !== null ? (
          <button className="quiet" onClick={() => void loadEvents(cursor)}>
            {t('Load more')}
          </button>
        ) : null}
      </div>
      <div hidden={tab !== 'History'} role="tabpanel" id="panel-History" aria-labelledby="tab-History">
        <p className="form-note">{t('Restoring creates a new version. Your current version stays in history.')}</p>
        <div className="history-list">
          {history.map((version) => (
            <button
              key={version.id}
              className="quiet"
              aria-pressed={selectedVersion?.id === version.id}
              onClick={() => setSelectedVersion(version)}
            >
              {t('Version')} {number(version.version)} · {dateTime(version.createdAt)}
            </button>
          ))}
        </div>
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
              <button
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
            ) : null}
          </>
        ) : null}
      </div>
      <div hidden={tab !== 'Executions'} role="tabpanel" id="panel-Executions" aria-labelledby="tab-Executions">
        {tab==='Executions'?<CardAutomation card={card} readOnly={readOnly} beforeRun={draft.flush} onChanged={()=>{void reload()}}/>:null}
        {detail.executions.map((job) => (
          <div className="status-pair" key={job.jobId}>
            <span>
              {job.personalDevice?<span>{t('Personal execution')} · {job.personalDevice.name} · </span>:null}
              {t('Job ·')} {t(job.jobState)}
            </span>
            <span>
              {t('Run ·')} {t(job.runState ?? 'not claimed')}
            </span>
          </div>
        ))}
        {!detail.executions.length ? <p>{t('No execution yet')}</p> : null}
        {detail.requests.map((request) => (
          <section key={request.jobId} className="card-section">
            {request.approvalId && canRequest ? (
              <div className="dialog-actions">
                {(['approved', 'rejected'] as const).map((decision) => (
                  <button
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
                  <button className="primary" onClick={() => setAnswering(request)}>
                    {t('Answer agent')}
                  </button>
                ) : null}
              </>
            ) : null}
          </section>
        ))}
        {detail.attempts.map((run) => (
          <article className="timeline-entry" key={run.id}>
            <header>
              <strong>
                {t('Attempt')} {number(run.attempt)} · {t(run.state)}
              </strong>
              {run.startedAt ? <time>{dateTime(run.startedAt)}</time> : null}
            </header>
            <Markdown value={run.outcome?.summary ?? run.outcome?.failure ?? ''} />
            <ExecutionConversation organizationId={card.organizationId} cardId={card.id} runId={run.id}/>
            <RunEvents organizationId={card.organizationId} cardId={card.id} runId={run.id}/>
          </article>
        ))}
        {detail.artifacts.map((item) => (
          <a
            className="attachment-row"
            key={item.id}
            href={`/api/v1/organizations/${card.organizationId}/artifacts/${item.id}/download?protocolVersion=1.0`}
          >
            {t(item.orphaned ? 'Orphaned evidence' : item.kind)} · {item.name}
          </a>
        ))}
        {canRequest ? (
          <button
            className="quiet"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                if (!(await draft.flush())) return
                const latest = await api<Detail>(base)
                await write(base + '/prepare', 'POST', { expectedVersion: latest.card.version })
                setNotice(
                  'Proposal requested. Applying it will still require a human action against the current card version.'
                )
                await reload()
              })
            }
          >
            {t('Prepare with AI')}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      {notice ? (
        <p className="success-message" role="status">
          {t(notice)}
        </p>
      ) : null}
      {!readOnly ? (
        <footer className="card-footer">
          {canRequest?<button className="primary" onClick={()=>setTab('Executions')}>{t('Column agent')}</button>:null}
          <button
            className="quiet"
            disabled={busy}
            onClick={() => setConfirmation(card.archivedAt ? 'restore' : 'archive')}
          >
            {t(card.archivedAt ? 'Restore' : 'Archive')}
          </button>
          <button className="quiet danger" disabled={busy} onClick={() => setConfirmation('delete')}>
            {t('Delete card')}
          </button>
          {active ? (
            <button className="quiet danger" onClick={() => setConfirmation('cancel')}>
              {t('Cancel executions')}
            </button>
          ) : null}
        </footer>
      ) : null}
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
      {nested ? (
        <CardDialog
          organizationId={card.organizationId}
          card={nested}
          readOnly={readOnly}
          onClose={() => {
            setNested(null)
            void reload()
          }}
          onChanged={() => {
            void reload()
            onChanged(card)
          }}
        />
      ) : null}
    </Modal>
  )
}
