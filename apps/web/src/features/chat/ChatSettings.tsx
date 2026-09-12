import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, Brain, Check, ChevronDown, Search, ShieldAlert, ShieldCheck, Zap } from 'lucide-react'
import type { ProjectChatDestination, ProjectChatModel, ProjectChatMode, ProjectChatSettings } from '@maestrly/protocol'
import { Select } from '../../components/Select.js'
import { t, useLocale } from '../../i18n/index.js'

function modelName(model: ProjectChatModel) {
  return model.providerLabel ? `${model.providerLabel} · ${model.label}` : model.label
}

function ModelPicker({
  models,
  value,
  disabled,
  onChange,
}: {
  models: ProjectChatModel[]
  value: string
  disabled: boolean
  onChange(value: string): void
}) {
  const listId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = models.find((model) => model.id === value)
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return query ? models.filter((model) => modelName(model).toLocaleLowerCase().includes(query)) : models
  }, [models, search])
  function close() {
    menu.current?.hidePopover()
    setOpen(false)
    setSearch('')
  }
  function show() {
    if (disabled || !models.length) return
    menu.current?.showPopover()
    setOpen(true)
  }
  useLayoutEffect(() => {
    if (!open) return
    const button = trigger.current
    const popup = menu.current
    if (!button || !popup) return
    const rect = button.getBoundingClientRect()
    const width = Math.min(320, innerWidth - 16)
    const height = Math.min(340, popup.scrollHeight)
    popup.style.width = width + 'px'
    popup.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px'
    // The composer sits at the bottom; open upward when there is no room below.
    const below = innerHeight - rect.bottom - 8
    popup.style.top = (below >= height ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)) + 'px'
    searchInput.current?.focus()
  }, [open])
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="chat-pill chat-model-trigger"
        role="combobox"
        aria-label={t('Model')}
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
      >
        <span>{selected ? modelName(selected) : t('Choose model')}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <div
        ref={menu}
        id={listId}
        popover="auto"
        className="chat-model-menu"
        onToggle={(event) => {
          const isOpen = event.newState === 'open'
          setOpen(isOpen)
          if (!isOpen) setSearch('')
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close()
            trigger.current?.focus()
          }
        }}
      >
        <label className="chat-model-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInput}
            type="search"
            aria-label={t('Search models')}
            placeholder={t('Search models')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div role="listbox" aria-label={t('Model')}>
          {filtered.map((model) => (
            <button
              type="button"
              role="option"
              aria-selected={model.id === value}
              key={model.id}
              onClick={() => {
                close()
                trigger.current?.focus()
                onChange(model.id)
              }}
            >
              <span>
                <strong>{model.label}</strong>
                {model.providerLabel ? <small>{model.providerLabel}</small> : null}
              </span>
              {model.id === value ? <Check size={15} aria-hidden="true" /> : null}
            </button>
          ))}
          {!filtered.length ? <p>{t('No models found.')}</p> : null}
        </div>
      </div>
    </>
  )
}

/** The web chat offers only acting (agent) and read-only (ask); other advertised modes are ignored. */
const WEB_MODES: ProjectChatMode[] = ['agent', 'ask']
const modeLabel = (mode: ProjectChatMode) => t(mode === 'agent' ? 'Agent' : 'Ask')
const permissionLabel = (mode: ProjectChatSettings['permMode']) =>
  t(mode === 'ask' ? 'Request approval' : mode === 'auto' ? 'Approve for me' : 'Full access')

interface SettingsProps {
  destination: ProjectChatDestination
  value: ProjectChatSettings
  disabled?: boolean
  saving?: boolean
  onChange(value: ProjectChatSettings): void | Promise<unknown>
}

const useApply = (onChange: SettingsProps['onChange']) => (next: ProjectChatSettings) =>
  void Promise.resolve(onChange(next)).catch(() => undefined)

/** Inline pills inside the composer: mode · effort · fast · model. Mirrors the desktop composer toolbar. */
export function ChatSettingsToolbar({ destination, value, disabled = false, saving = false, onChange }: SettingsProps) {
  useLocale()
  const controls = destination.inventory.conversationSettings
  const selectedModel = destination.inventory.models.find((model) => model.id === value.model)
  const locked = disabled || saving
  const modes: ProjectChatMode[] = controls
    ? WEB_MODES.filter((mode) => (controls.modes as ProjectChatMode[]).includes(mode))
    : ['agent', 'chat']
  const displayedMode = value.mode === 'chat' && controls ? 'ask' : value.mode
  const apply = useApply(onChange)
  return (
    <div className="chat-toolbar" role="group" aria-label={t('Chat settings')}>
      <span className="chat-pill-group">
        <Bot size={13} aria-hidden="true" />
        <Select
          label={t('Chat mode')}
          value={displayedMode}
          disabled={locked}
          options={modes.map((mode) => ({ value: mode, label: modeLabel(mode) }))}
          onChange={(mode) => apply({ ...value, mode: mode as ProjectChatMode })}
        />
      </span>
      {selectedModel?.efforts.length ? (
        <span className="chat-pill-group">
          <Brain size={13} aria-hidden="true" />
          <Select
            label={t('Reasoning effort')}
            value={value.reasoning ?? ''}
            disabled={locked}
            options={[
              { value: '', label: t('Default effort') },
              ...selectedModel.efforts.map((effort) => ({ value: effort, label: t(effort) })),
            ]}
            onChange={(reasoning) => apply({ ...value, reasoning: reasoning || null })}
          />
        </span>
      ) : null}
      {selectedModel?.fastMode ? (
        <button
          type="button"
          className="chat-pill chat-fast-toggle"
          aria-label={t('Fast mode')}
          aria-pressed={value.fastMode}
          disabled={locked}
          onClick={() => apply({ ...value, fastMode: !value.fastMode })}
        >
          <Zap size={13} aria-hidden="true" />
          {t('Fast')}
        </button>
      ) : null}
      <ModelPicker
        models={destination.inventory.models}
        value={value.model}
        disabled={locked}
        onChange={(modelId) => {
          const model = destination.inventory.models.find((candidate) => candidate.id === modelId)!
          apply({
            ...value,
            model: modelId,
            reasoning: value.reasoning && model.efforts.includes(value.reasoning) ? value.reasoning : null,
            fastMode: model.fastMode ? value.fastMode : false,
          })
        }}
      />
    </div>
  )
}

/** Permission profile line under the composer, plus the executor's hard limits as short hints. */
export function ChatPermissionBar({ destination, value, disabled = false, saving = false, onChange }: SettingsProps) {
  useLocale()
  const controls = destination.inventory.conversationSettings
  const locked = disabled || saving
  const apply = useApply(onChange)
  const permMode = controls ? value.permMode : 'ask'
  const limits = controls?.operatorLimits
  const disabledLimits = limits
    ? [
        !limits.commands && t('Commands are disabled by the executor.'),
        !limits.web && t('Web access is disabled by the executor.'),
        !limits.appTools && t('App tools are disabled by the executor.'),
        !limits.mcp && t('MCPs are disabled by the executor.'),
        !limits.push && t('Git push is disabled by the executor.'),
      ].filter((message): message is string => Boolean(message))
    : []
  const hint = !controls
    ? t('Update the executor to change effort, mode, or access.')
    : disabled
      ? t('Settings unlock when the current turn ends.')
      : saving
        ? t('Saving settings…')
        : ''
  return (
    <div className={'chat-permission-bar' + (permMode === 'full' ? ' full-access' : '')}>
      <span className="chat-permission-control">
        {permMode === 'full' ? <ShieldAlert size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
        <Select
          label={t('Permission profile')}
          value={permMode}
          disabled={locked || !controls}
          options={(controls?.permissionModes ?? ['ask']).map((mode) => ({ value: mode, label: permissionLabel(mode) }))}
          onChange={(next) => apply({ ...value, permMode: next as ProjectChatSettings['permMode'] })}
        />
      </span>
      <small className="chat-permission-hints" role={saving ? 'status' : undefined}>
        {hint ? <span>{hint}</span> : null}
        {disabledLimits.map((message) => (
          <span key={message}>{message}</span>
        ))}
      </small>
    </div>
  )
}

/** Stacked layout for the new-conversation form. */
export function ChatSettings(props: SettingsProps) {
  return (
    <div className="chat-settings">
      <ChatSettingsToolbar {...props} />
      <ChatPermissionBar {...props} />
    </div>
  )
}
