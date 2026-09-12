import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  ArrowDown,
  GitBranch,
  History,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pencil,
  Plus,
  X,
} from 'lucide-react'
import type { Card, ProjectChatSettings } from '@maestrly/protocol'
import { api } from '../../app/api.js'
import { t, useLocale, errorText } from '../../i18n/index.js'
import { Select } from '../../components/Select.js'
import { FormDialog } from '../../components/FormDialog.js'
import { CardDialog } from '../cards/CardDialog.js'
import { useProjectChat } from './use-project-chat.js'
import { ChatComposer } from './ChatComposer.js'
import { ChatSessionList } from './ChatSessionList.js'
import { ChatMessages } from './ChatMessages.js'
import { ChatInteractions } from './ChatInteractions.js'
import { ChatPermissionBar, ChatSettings, ChatSettingsToolbar } from './ChatSettings.js'

const initialSettings: ProjectChatSettings = {
  model: '',
  mode: 'agent',
  reasoning: null,
  fastMode: false,
  permMode: 'ask',
}

export function ProjectChatDrawer({
  organizationId,
  projectId,
  projectName,
  userId,
  boardId,
  cardId,
  onClose,
}: {
  organizationId: string
  projectId: string
  projectName: string
  userId: string
  boardId?: string
  cardId?: string
  onClose(): void
}) {
  useLocale()
  const chat = useProjectChat(organizationId, projectId, userId)
  const [history, setHistory] = useState(false),
    [expanded, setExpanded] = useState(false),
    [renaming, setRenaming] = useState(false)
  const [runnerId, setRunnerId] = useState(''),
    [workspaceKey, setWorkspaceKey] = useState(''),
    [branch, setBranch] = useState('')
  const [settings, setSettings] = useState<ProjectChatSettings>(initialSettings)
  const [selectedCard, setSelectedCard] = useState<Card | null>(null),
    [newMessages, setNewMessages] = useState(false)
  const [small, setSmall] = useState(() => matchMedia('(max-width:850px)').matches)
  const panel = useRef<HTMLElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    follow = useRef(true)
  const [localError, setLocalError] = useState('')
  const data = chat.data?.session.id === chat.sessionId ? chat.data : null
  const destination =
    chat.destinations.find((d) => d.runnerId === (data?.session.runnerId ?? runnerId)) ??
    (!data ? chat.destinations[0] : undefined)
  const workspace =
    destination?.inventory.workspaces.find((w) => w.key === workspaceKey) ?? destination?.inventory.workspaces[0]
  const selectedModel =
    destination?.inventory.models.find((candidate) => candidate.id === settings.model) ??
    destination?.inventory.models[0]
  const draftSettings = { ...settings, model: selectedModel?.id ?? '' }
  const selectedBranch = workspace?.branches.includes(branch) ? branch : workspace?.branches[0]
  const active = !!data?.turn && ['queued', 'running', 'waiting_input', 'cancelling'].includes(data.turn.state)
  const sessionSettings: ProjectChatSettings = data
    ? {
        model: data.session.model,
        mode: data.session.mode,
        reasoning: data.session.reasoning,
        fastMode: data.session.fastMode,
        permMode: data.session.permMode,
      }
    : initialSettings
  const pendingPlan = data?.interactions.some((i) => i.state === 'pending' && i.payload.type === 'plan') ?? false
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const media = matchMedia('(max-width:850px)'),
      change = () => setSmall(media.matches)
    media.addEventListener('change', change)
    return () => {
      media.removeEventListener('change', change)
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (cardId) chat.setSessionId('')
  }, [cardId])
  useEffect(() => {
    follow.current = true
    setNewMessages(false)
  }, [chat.sessionId])
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    if (follow.current) el.scrollTop = el.scrollHeight
    else setNewMessages(true)
  }, [data?.cursor, chat.sessionId])
  const openCard = useCallback(
    (id: string) => {
      void api<{ card: Card }>(`/api/v1/organizations/${organizationId}/cards/${id}`)
        .then((detail) => {
          if (detail.card.projectId === projectId) setSelectedCard(detail.card)
        })
        .catch((e) => setLocalError(e.message))
    },
    [organizationId, projectId]
  )
  const perform = (operation: () => Promise<unknown>) => void operation().catch(() => {})
  return (
    <aside
      ref={panel}
      className={'project-chat-drawer' + (expanded ? ' expanded' : '')}
      role="dialog"
      aria-modal={small || expanded}
      aria-label={t('Project chat')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
        if (e.key === 'Tab' && (small || expanded)) {
          const controls = [
            ...panel.current!.querySelectorAll<HTMLElement>(
              'button:not(:disabled),textarea:not(:disabled),input:not(:disabled),[tabindex="0"],a[href]'
            ),
          ].filter((el) => el.getClientRects().length)
          const first = controls[0],
            last = controls.at(-1)
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last?.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first?.focus()
          }
        }
      }}
    >
      <header className="project-chat-top">
        <div>
          <MessageSquare size={19} />
          <h2>{t('Project chat')}</h2>
        </div>
        <div>
          <button
            className="icon-button"
            aria-label={t('Chat history')}
            aria-pressed={history}
            onClick={() => setHistory(!history)}
          >
            <History size={17} />
          </button>
          <button
            className="icon-button"
            aria-label={t('New conversation')}
            onClick={() => {
              chat.setSessionId('')
              setHistory(false)
            }}
          >
            <Plus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label={t(expanded ? 'Collapse chat' : 'Expand chat')}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <button className="icon-button" aria-label={t('Close chat')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </header>
      {history ? (
        <ChatSessionList
          sessions={chat.sessions}
          selected={chat.sessionId}
          onSelect={(id) => {
            chat.setSessionId(id)
            setHistory(false)
          }}
          onNew={() => {
            chat.setSessionId('')
            setHistory(false)
          }}
          more={!!chat.nextCursor}
          onMore={() => perform(chat.moreSessions)}
        />
      ) : null}
      <div className="project-chat-context">
        <strong>{projectName}</strong>
        <span>{t('Only you can see this conversation.')}</span>
        {data ? (
          <>
            <div>
              <GitBranch size={13} />
              <code>{data.session.baseBranch}</code>
              <span>{destination?.name ?? t('Executor unavailable')}</span>
            </div>
            <div>
              <strong>{data.session.title}</strong>
              <button className="icon-button" aria-label={t('Rename conversation')} onClick={() => setRenaming(true)}>
                <Pencil size={13} />
              </button>
              <button
                className="icon-button"
                disabled={active}
                aria-label={t('Archive conversation')}
                onClick={() => perform(chat.archive)}
              >
                <Archive size={13} />
              </button>
            </div>
          </>
        ) : null}
        {(data?.session.cardId ?? cardId) ? (
          <button className="quiet" onClick={() => openCard((data?.session.cardId ?? cardId)!)}>
            {t('Open card')} · {(data?.session.cardId ?? cardId)!.slice(0, 8)}
          </button>
        ) : null}
      </div>
      <div
        className="project-chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70
          if (follow.current) setNewMessages(false)
        }}
      >
        {!chat.sessionId ? (
          <div className="project-chat-setup">
            <div className="chat-welcome">
              <img src="/brand/mark-full.svg" alt="" />
              <h3>{t('Work with your project.')}</h3>
              <p>
                {t('Explore the code, recall a decision or find completed work. Your executor brings the context.')}
              </p>
            </div>
            {!destination ? (
              <div className="chat-unavailable">
                <p>{t('No interactive executor available.')}</p>
                <p>
                  {t(
                    'Update Maestrly desktop, link this project and enable interactive web chat in executor settings.'
                  )}
                </p>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!workspace || !selectedModel || !selectedBranch) return
                  perform(() =>
                    chat.create({
                      runnerId: destination.runnerId,
                      workspaceKey: workspace.key,
                      ...draftSettings,
                      baseBranch: selectedBranch,
                      title: t('New conversation'),
                      boardId: boardId ?? null,
                      cardId: cardId ?? null,
                    })
                  )
                }}
              >
                <label>
                  {t('Executor')}
                  <Select
                    label={t('Executor')}
                    value={destination.runnerId}
                    options={chat.destinations.map((d) => ({
                      value: d.runnerId,
                      label: d.name + (d.online ? '' : ' · ' + t('Offline')),
                    }))}
                    onChange={(id) => {
                      setRunnerId(id)
                      setWorkspaceKey('')
                      setSettings(initialSettings)
                      setBranch('')
                    }}
                  />
                </label>
                <label>
                  {t('Code workspace')}
                  <Select
                    label={t('Code workspace')}
                    value={workspace?.key ?? ''}
                    options={destination.inventory.workspaces.map((w) => ({ value: w.key, label: w.label }))}
                    onChange={(key) => {
                      setWorkspaceKey(key)
                      setBranch('')
                    }}
                  />
                </label>
                <div className="chat-setup-grid single">
                  <label>
                    {t('Base branch')}
                    <Select
                      label={t('Base branch')}
                      value={selectedBranch ?? ''}
                      options={(workspace?.branches ?? []).map((b) => ({ value: b, label: b }))}
                      onChange={setBranch}
                    />
                  </label>
                </div>
                <ChatSettings destination={destination} value={draftSettings} onChange={setSettings} />
                <div className="chat-integrations">
                  {(['skills', 'mcp', 'memory'] as const).map((key) => (
                    <span key={key} className={destination.inventory.integrations[key] ? 'available' : ''}>
                      {t(key === 'mcp' ? 'MCPs' : key === 'skills' ? 'Skills' : 'Project memory')} ·{' '}
                      {t(destination.inventory.integrations[key] ? 'Available' : 'Unavailable')}
                    </span>
                  ))}
                </div>
                <button className="primary" disabled={chat.busy || !workspace || !selectedBranch || !selectedModel}>
                  {t('Start conversation')}
                </button>
              </form>
            )}
          </div>
        ) : data ? (
          <>
            {data.more ? (
              <button className="quiet" disabled={chat.busy} onClick={() => perform(chat.earlier)}>
                {t('Earlier messages')}
              </button>
            ) : null}
            <ChatMessages messages={data.messages} onCard={openCard} />
            <ChatInteractions
              items={data.interactions}
              busy={chat.busy || (!!data.turn && ['running', 'cancelling'].includes(data.turn.state) && pendingPlan)}
              onDecide={(i, d) => perform(() => chat.decide(i.id, i.version, d))}
            />
          </>
        ) : (
          <p>{t('Loading conversation…')}</p>
        )}
        {data?.turn?.error ? <p className="form-error">{errorText(data.turn.error)}</p> : null}
      </div>
      {newMessages ? (
        <button
          className="quiet chat-new-messages"
          onClick={() => {
            follow.current = true
            const el = scroller.current
            if (el) el.scrollTop = el.scrollHeight
            setNewMessages(false)
          }}
        >
          <ArrowDown size={14} />
          {t('New messages')}
        </button>
      ) : null}
      {chat.error || localError ? (
        <p className="form-error chat-error" role="alert">
          {errorText(chat.error || localError)}{' '}
          <button
            className="quiet"
            onClick={() => {
              setLocalError('')
              chat.refresh()
            }}
          >
            {t('Reload')}
          </button>
        </p>
      ) : null}
      {data ? (
        <>
          <div className="chat-stream-status" role="status">
            <i className={active ? 'working' : ''} />
            {t(
              chat.connection === 'reconnecting'
                ? 'Reconnecting'
                : pendingPlan
                  ? 'Waiting for plan review'
                  : data.turn?.state === 'queued'
                    ? 'Waiting for this executor'
                    : data.turn?.state === 'waiting_input'
                      ? 'Waiting for your response'
                      : active
                        ? 'Working…'
                        : data.turn?.state === 'interrupted'
                          ? 'Interrupted'
                          : !destination?.online
                            ? 'Executor offline'
                            : 'Ready to chat'
            )}
          </div>
          <ChatComposer
            key={chat.storageKey + chat.sessionId}
            draftKey={chat.storageKey + ':draft:' + chat.sessionId}
            busy={chat.busy}
            disabled={pendingPlan || !destination}
            active={active}
            toolbar={
              destination ? (
                <ChatSettingsToolbar
                  destination={destination}
                  value={sessionSettings}
                  disabled={active}
                  saving={chat.busy}
                  onChange={chat.updateSettings}
                />
              ) : undefined
            }
            onSend={chat.send}
            onStop={() => perform(chat.cancel)}
          />
          {destination ? (
            <ChatPermissionBar
              destination={destination}
              value={sessionSettings}
              disabled={active}
              saving={chat.busy}
              onChange={chat.updateSettings}
            />
          ) : null}
        </>
      ) : null}
      {renaming && data ? (
        <FormDialog
          title={t('Rename conversation')}
          submitLabel={t('Save changes')}
          onClose={() => setRenaming(false)}
          onSubmit={async (form) => {
            await chat.rename(String(form.get('title') ?? ''))
            setRenaming(false)
          }}
        >
          <label>
            {t('Title')}
            <input name="title" defaultValue={data.session.title} maxLength={160} required />
          </label>
        </FormDialog>
      ) : null}
      {selectedCard ? (
        <CardDialog
          organizationId={organizationId}
          card={selectedCard}
          onClose={() => setSelectedCard(null)}
          onChanged={(card) => setSelectedCard(card)}
        />
      ) : null}
    </aside>
  )
}
