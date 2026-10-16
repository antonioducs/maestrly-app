import { WebSearchSettings } from './WebSearchSettings'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, Plus, X, Pencil, Sparkles } from 'lucide-react'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import { DEFAULT_REASONING_EFFORTS, isChatProviderConnected } from '../../../shared/chat'
import type { ChatConfig, ChatModelMeta, ChatUserPrompt, McpServerInfo } from '../../../shared/chat'
import { APP_TOOL_GROUPS } from '../../../shared/app-tool-groups'
import { SubagentProfilesSettings } from './subagent-profiles/SubagentProfilesSettings'
import { SkillsSettings } from './SkillsSettings'
import { CHAT_SETTINGS_TABS, type ChatSettingsOptions, type ChatSettingsTab } from './chat-settings-tabs'
import { MaestroSettings } from './MaestroSettings'
import { MemorySettings } from './MemorySettings'
import { BackgroundCompactionSettings } from './BackgroundCompactionSettings'
import { RuntimeComponentsSettings } from './RuntimeComponentsSettings'
import { AccountsSettingsPanel } from './accounts/AccountsSettingsPanel'
import { inputCls } from './accounts/account-ui'

export function ApiKeySettings({
  tabs,
  requestedTab,
  appToolsLocked = false,
  backgroundCompactionLocked = false,
}: ChatSettingsOptions = {}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [config, setConfig] = useState<ChatConfig | null>(null)
  const visibleTabs = tabs ? CHAT_SETTINGS_TABS.filter((tab) => tabs.includes(tab.id)) : CHAT_SETTINGS_TABS
  const shown = (id: ChatSettingsTab) => visibleTabs.some((tab) => tab.id === id)
  const [activeTab, setActiveTab] = useState<ChatSettingsTab>(() => visibleTabs[0]?.id ?? 'accounts')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const [modelFilterRevision, setModelFilterRevision] = useState(0)

  const refresh = () => api.chatConfig().then(setConfig)
  const modelFilterChanged = () => setModelFilterRevision((revision) => revision + 1)
  useEffect(() => {
    refresh()
  }, [])
  // A requested tab left out of `tabs` is ignored rather than showing a hidden panel.
  const requestedTabId = requestedTab && (!tabs || tabs.includes(requestedTab.tab)) ? requestedTab.tab : null
  useEffect(() => {
    if (requestedTabId) setActiveTab(requestedTabId)
  }, [requestedTabId, requestedTab?.seq])

  if (!config) return <div className="text-[12px] text-muted-foreground">{t('settings.loading')}</div>

  const onTabKeyDown = (index: number, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? visibleTabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length
    setActiveTab(visibleTabs[next].id)
    tabRefs.current[next]?.focus()
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        role="tablist"
        aria-label={t('settings.tabsLabel')}
        className="sticky top-0 z-10 flex gap-1 overflow-x-auto rounded-lg border border-border bg-popover p-1 shadow-sm"
      >
        {visibleTabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => {
              tabRefs.current[index] = node
            }}
            id={`chat-settings-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`chat-settings-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => onTabKeyDown(index, event)}
            className={cn(
              'shrink-0 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors',
              activeTab === tab.id
                ? 'bg-white/[0.09] text-foreground'
                : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'
            )}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {shown('accounts') && (
        <div
          id="chat-settings-panel-accounts"
          role="tabpanel"
          aria-labelledby="chat-settings-tab-accounts"
          hidden={activeTab !== 'accounts'}
        >
          <AccountsSettingsPanel config={config} onChanged={refresh} onModelFilterChanged={modelFilterChanged} />
        </div>
      )}
      {shown('models') && (
        <div
          id="chat-settings-panel-models"
          role="tabpanel"
          aria-labelledby="chat-settings-tab-models"
          hidden={activeTab !== 'models'}
          className={cn('flex flex-col gap-3', activeTab !== 'models' && 'hidden')}
        >
          {config.providers.some(isChatProviderConnected) && (
            <DefaultModelPicker config={config} onChanged={refresh} modelFilterRevision={modelFilterRevision} />
          )}
          {config.providers.some(isChatProviderConnected) && (
            <ImageInterpreterPicker config={config} onChanged={refresh} modelFilterRevision={modelFilterRevision} />
          )}
          <BackgroundCompactionSettings
            config={config}
            catalogRevision={modelFilterRevision}
            onChanged={refresh}
            locked={backgroundCompactionLocked}
          />
          <MemorySettings
            config={config}
            catalogRevision={modelFilterRevision}
            onChanged={refresh}
            locked={backgroundCompactionLocked}
          />
          <MemorySettings
            scope="personal"
            config={config}
            catalogRevision={modelFilterRevision}
            onChanged={refresh}
            locked={backgroundCompactionLocked}
          />
          <SubagentProfilesSettings config={config} />
        </div>
      )}
      {shown('maestro') && (
        <div
          id="chat-settings-panel-maestro"
          role="tabpanel"
          aria-labelledby="chat-settings-tab-maestro"
          hidden={activeTab !== 'maestro'}
        >
          <MaestroSettings config={config} />
        </div>
      )}
      {shown('tools') && (
        <div
          id="chat-settings-panel-tools"
          role="tabpanel"
          aria-labelledby="chat-settings-tab-tools"
          hidden={activeTab !== 'tools'}
          className={cn('flex flex-col gap-3', activeTab !== 'tools' && 'hidden')}
        >
          <FlagToggle
            headingKey="settings.appToolsHeading"
            descriptionKey="settings.appToolsDescription"
            enabled={config.appToolsEnabled}
            setEnabled={api.chatSetAppTools}
            onChanged={refresh}
            lockedDescriptionKey={appToolsLocked ? 'plusMenu.appToolsBotLocked' : undefined}
          />
          {!appToolsLocked && <AppToolGroupSettings config={config} onChanged={refresh} />}
          <FlagToggle
            headingKey="settings.imageGenHeading"
            descriptionKey="settings.imageGenDescription"
            enabled={config.imageGenEnabled}
            setEnabled={api.chatSetImageGen}
            onChanged={refresh}
          />
          {config.webSearch && <WebSearchSettings webSearch={config.webSearch} onChanged={refresh} />}
          <FlagToggle
            headingKey="settings.generatedInterfacesHeading"
            descriptionKey="settings.generatedInterfacesDescription"
            enabled={config.generatedInterfacesEnabled}
            setEnabled={api.chatSetGeneratedInterfaces}
            onChanged={refresh}
          />
          <FlagToggle
            headingKey="settings.bashFiltersHeading"
            descriptionKey="settings.bashFiltersDescription"
            enabled={config.bashFiltersEnabled}
            setEnabled={api.chatSetBashFilters}
            onChanged={refresh}
          />
          <McpSettings servers={config.mcpServers} onChanged={refresh} />
        </div>
      )}
      {shown('skills') && (
        <div
          id="chat-settings-panel-skills"
          role="tabpanel"
          aria-labelledby="chat-settings-tab-skills"
          hidden={activeTab !== 'skills'}
        >
          <SkillsSettings />
        </div>
      )}
      {shown('prompts') && (
        <div
          id="chat-settings-panel-prompts"
          role="tabpanel"
          aria-labelledby="chat-settings-tab-prompts"
          hidden={activeTab !== 'prompts'}
        >
          <PromptsSettings />
        </div>
      )}
      {shown('components') && (
        <div
          id="chat-settings-panel-components"
          role="tabpanel"
          aria-labelledby="chat-settings-tab-components"
          hidden={activeTab !== 'components'}
        >
          <RuntimeComponentsSettings />
        </div>
      )}
    </div>
  )
}

function PromptsSettings() {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [prompts, setPrompts] = useState<ChatUserPrompt[]>([])
  const [editing, setEditing] = useState<ChatUserPrompt | 'new' | null>(null)

  const refresh = () => api.chatPrompts().then(setPrompts)
  useEffect(() => {
    refresh()
  }, [])

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="text-[12px] font-medium text-foreground">{t('settings.savedPromptsHeading')}</span>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.savedPromptsDescription')}</p>
        </div>
        {editing === null && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-foreground hover:bg-white/5"
          >
            <Plus className="h-3.5 w-3.5" /> {t('settings.new')}
          </button>
        )}
      </div>

      {prompts.length === 0 && editing === null && (
        <p className="text-[11px] text-muted-foreground">{t('settings.noSavedPrompts')}</p>
      )}

      <div className="flex flex-col gap-1.5">
        {prompts.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-2.5 py-1.5"
          >
            <span className="shrink-0 font-mono text-[12px] text-foreground">/{p.name}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {p.description || p.content}
            </span>
            <button
              type="button"
              onClick={() => {
                if (!confirm(t('settings.skillConvertConfirm', { name: p.name }))) return
                void api.chatSkillFromPrompt(p.id).then(() => {
                  refresh()

                  window.dispatchEvent(new Event('maestrly:skills-changed'))
                })
              }}
              className="shrink-0 text-muted-foreground hover:text-violet-300"
              title={t('settings.skillConvertToSkill')}
            >
              <Sparkles className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setEditing(p)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              title={t('settings.edit')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void api.chatPromptRemove(p.id).then(refresh)}
              className="shrink-0 text-muted-foreground hover:text-destructive"
              title={t('settings.remove')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {editing !== null && (
        <PromptForm
          prompt={editing === 'new' ? undefined : editing}
          onDone={() => {
            setEditing(null)
            refresh()
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function PromptForm({
  prompt,
  onDone,
  onCancel,
}: {
  prompt?: ChatUserPrompt
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [name, setName] = useState(prompt?.name ?? '')
  const [description, setDescription] = useState(prompt?.description ?? '')
  const [content, setContent] = useState(prompt?.content ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError('')
    const res = prompt
      ? await api.chatPromptUpdate(prompt.id, {
          name,
          description,
          content,
        })
      : await api.chatPromptAdd({ name, description, content })
    setBusy(false)
    if (res.ok) onDone()
    else setError((res as { error?: string }).error || t('settings.errSavePrompt'))
  }

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-white/[0.02] px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-medium text-foreground">
          {prompt ? t('settings.editPrompt') : t('settings.newPrompt')}
        </span>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <input
          className={inputCls}
          placeholder={t('settings.promptNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={inputCls}
          placeholder={t('settings.promptDescriptionPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <textarea
          className={cn(inputCls, 'min-h-[80px] resize-y font-mono text-[12px]')}
          placeholder={t('settings.promptContentPlaceholder')}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-white/5"
          >
            {t('settings.cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !name.trim() || !content.trim()}
            className="rounded-md bg-indigo-500 px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
          >
            {t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function FlagToggle({
  headingKey,
  descriptionKey,
  enabled,
  setEnabled,
  onChanged,
  lockedDescriptionKey,
}: {
  headingKey: string
  descriptionKey: string
  enabled: boolean
  setEnabled: (enabled: boolean) => Promise<{ ok: boolean }>
  onChanged: () => void
  /** Shows the flag on and read-only, explaining why with this text. */
  lockedDescriptionKey?: string
}) {
  const { t } = useTranslation('chat')
  const locked = Boolean(lockedDescriptionKey)
  const on = locked || enabled
  return (
    <div className="mt-1 flex items-start justify-between gap-3 border-t border-border pt-3">
      <div className="min-w-0">
        <span className="text-[12px] font-medium text-foreground">{t(headingKey)}</span>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t(lockedDescriptionKey ?? descriptionKey)}</p>
      </div>
      <button
        type="button"
        onClick={() => setEnabled(!enabled).then(onChanged)}
        disabled={locked}
        className={cn(
          'mt-0.5 h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors',
          on ? 'bg-emerald-500/70' : 'bg-white/10',
          locked && 'cursor-not-allowed opacity-40'
        )}
        title={on ? t('settings.toggleOn') : t('settings.toggleOff')}
        aria-label={t(headingKey)}
        aria-pressed={on}
      >
        <span className={cn('block h-3 w-3 rounded-full bg-white transition-transform', on && 'translate-x-3')} />
      </button>
    </div>
  )
}

/** Global default of each app-tool group; inactive while the whole surface is off. */
function AppToolGroupSettings({ config, onChanged }: { config: ChatConfig; onChanged: () => void }) {
  const api = useHostApi()
  const { t } = useTranslation('chat')
  const inactive = !config.appToolsEnabled
  return (
    <div className="-mt-1 flex flex-col gap-0.5 border-l border-border pl-3" aria-disabled={inactive}>
      <p className="mb-1 text-[11px] text-muted-foreground">{t('settings.appToolGroupsDescription')}</p>
      {APP_TOOL_GROUPS.map((group) => {
        const on = config.appToolGroups?.[group] ?? true
        const label = t(`appToolGroups.${group}.label`)
        return (
          <div key={group} className={cn('flex items-center justify-between gap-3 py-0.5', inactive && 'opacity-50')}>
            <div className="min-w-0 truncate">
              <span className="text-[12px] text-foreground">{label}</span>
              <span className="ml-1.5 text-[11px] text-muted-foreground">{t(`appToolGroups.${group}.desc`)}</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={label}
              disabled={inactive}
              onClick={() => api.chatSetAppToolGroup(group, !on).then(onChanged)}
              className={cn(
                'h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors disabled:cursor-not-allowed',
                on ? 'bg-emerald-500/70' : 'bg-white/10'
              )}
              title={on ? t('settings.toggleOn') : t('settings.toggleOff')}
            >
              <span className={cn('block h-3 w-3 rounded-full bg-white transition-transform', on && 'translate-x-3')} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function DefaultModelPicker({
  config,
  onChanged,
  modelFilterRevision,
}: {
  config: ChatConfig
  onChanged: () => void
  modelFilterRevision: number
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const connectedProviders = config.providers.filter(isChatProviderConnected)
  const initialProviderId = config.defaultSelection?.providerId ?? connectedProviders[0]?.id ?? ''
  const [providerId, setProviderId] = useState(initialProviderId)
  const [modelId, setModelId] = useState(
    config.defaultSelection?.providerId === initialProviderId ? config.defaultSelection.modelId : ''
  )
  const [reasoning, setReasoning] = useState(config.defaultReasoning || 'off')
  const [meta, setMeta] = useState<ChatModelMeta | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [manual, setManual] = useState(false)
  const manualChosenRef = useRef(false)

  const providerConnected = connectedProviders.some((provider) => provider.id === providerId)
  const selectableProviders = config.providers.filter(
    (provider) => isChatProviderConnected(provider) || provider.id === config.defaultSelection?.providerId
  )

  useEffect(() => {
    if (!providerId || !providerConnected) {
      setModels([])
      setLoading(false)
      return
    }
    let alive = true
    setModels([])
    setLoading(true)
    api
      .chatModels(providerId)
      .then((m) => {
        if (!alive) return
        setModels(m)
        if (m.length === 0) setManual(true)
        else if (!manualChosenRef.current) setManual(false)
      })
      .catch(() => {
        if (alive) setModels([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [providerId, providerConnected, modelFilterRevision, api])

  useEffect(() => {
    if (!modelId) {
      setMeta(null)
      return
    }
    let alive = true
    api.chatModelMeta(modelId, providerId).then((m) => alive && setMeta(m))
    return () => {
      alive = false
    }
  }, [modelId, providerId, api])

  const efforts = meta?.reasoningEfforts?.length ? meta.reasoningEfforts : [...DEFAULT_REASONING_EFFORTS]

  useEffect(() => {
    if (reasoning !== 'off' && meta?.reasoning && !efforts.includes(reasoning)) {
      setReasoning('off')
      if (providerId && modelId) api.chatSetDefault({ providerId, modelId, reasoning: 'off' }).then(onChanged)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, modelId, api])

  const commit = (pId: string, mId: string, r: string = reasoning) => {
    if (pId && mId) api.chatSetDefault({ providerId: pId, modelId: mId, reasoning: r }).then(onChanged)
  }

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <span className="text-[12px] font-medium text-foreground">{t('settings.defaultModelHeading')}</span>
      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect
          value={providerId}
          onValueChange={(selectedValue) => {
            setProviderId(selectedValue)
            setModelId('')
            manualChosenRef.current = false
            setManual(false)
          }}
          className="h-8 w-auto max-w-full text-[13px]"
        >
          {selectableProviders.map((p) => (
            <SelectOption key={p.id} value={p.id}>
              {p.name}
            </SelectOption>
          ))}
        </OptionSelect>
        {manual ? (
          <input
            disabled={!providerConnected}
            className={cn(inputCls, 'min-w-[220px] flex-1')}
            placeholder={t('settings.modelIdPlaceholder')}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            onBlur={() => commit(providerId, modelId)}
          />
        ) : (
          <OptionSelect
            value={modelId}
            disabled={loading || !providerConnected}
            onValueChange={(selectedValue) => {
              if (selectedValue === '__manual__') {
                manualChosenRef.current = true
                setManual(true)
                setModelId('')
                return
              }
              setModelId(selectedValue)
              commit(providerId, selectedValue)
            }}
            className="h-8 w-auto max-w-full text-[13px]"
          >
            <SelectOption value="">{loading ? t('settings.loadingModels') : t('settings.chooseModel')}</SelectOption>
            {!providerConnected && modelId && <SelectOption value={modelId}>{modelId}</SelectOption>}
            {models.map((m) => (
              <SelectOption key={m} value={m}>
                {m}
              </SelectOption>
            ))}
            <SelectOption value="__manual__">{t('settings.enterIdManually')}</SelectOption>
          </OptionSelect>
        )}
        {meta?.reasoning && (
          <OptionSelect
            value={efforts.includes(reasoning) ? reasoning : 'off'}
            onValueChange={(selectedValue) => {
              setReasoning(selectedValue)
              commit(providerId, modelId, selectedValue)
            }}
            className="h-8 w-auto max-w-full text-[13px]"
            title={t('reasoning.buttonTitle')}
          >
            <SelectOption value="off">{t('reasoning.default')}</SelectOption>
            {efforts.map((eff) => (
              <SelectOption key={eff} value={eff}>
                {eff}
              </SelectOption>
            ))}
          </OptionSelect>
        )}
        <button
          type="button"
          disabled={!providerConnected}
          onClick={() => api.chatModels(providerId, true).then(setModels)}
          className="rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-white/5"
          title={t('settings.reloadModelsTitle')}
        >
          {t('settings.reload')}
        </button>
      </div>
    </div>
  )
}

function ImageInterpreterPicker({
  config,
  onChanged,
  modelFilterRevision,
}: {
  config: ChatConfig
  onChanged: () => void
  modelFilterRevision: number
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const connectedProviders = config.providers.filter(isChatProviderConnected)
  const [providerId, setProviderId] = useState(config.imageInterpreter?.providerId ?? '')
  const [modelId, setModelId] = useState(config.imageInterpreter?.modelId ?? '')
  const [effort, setEffort] = useState(config.imageInterpreter?.effort ?? 'off')
  const [models, setModels] = useState<string[]>([])
  const [meta, setMeta] = useState<ChatModelMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [manual, setManual] = useState(false)

  useEffect(() => {
    if (!providerId) {
      setModels([])
      return
    }
    let alive = true
    setModels([])
    setLoading(true)
    api
      .chatModels(providerId)
      .then((m) => {
        if (!alive) return
        setModels(m)
        if (m.length === 0) setManual(true)
      })
      .catch(() => alive && setModels([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [providerId, modelFilterRevision, api])

  useEffect(() => {
    if (!providerId || !modelId) {
      setMeta(null)
      return
    }
    let alive = true
    api.chatModelMeta(modelId, providerId).then((m) => alive && setMeta(m))
    return () => {
      alive = false
    }
  }, [modelId, providerId, api])

  const efforts = meta?.reasoningEfforts?.length ? meta.reasoningEfforts : [...DEFAULT_REASONING_EFFORTS]
  const commit = (pId: string, mId: string, eff: string) => {
    const value =
      pId && mId
        ? {
            providerId: pId,
            modelId: mId,
            ...(eff && eff !== 'off' ? { effort: eff } : {}),
          }
        : null
    void api.chatSetImageInterpreter(value).then(onChanged)
  }

  // Reject tool schemas that provider runtimes cannot describe.
  useEffect(() => {
    if (!meta || effort === 'off') return
    if (meta.reasoning && efforts.includes(effort)) return
    setEffort('off')
    if (providerId && modelId) commit(providerId, modelId, 'off')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta])

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <div className="min-w-0">
        <span className="text-[12px] font-medium text-foreground">{t('settings.imageInterpreterHeading')}</span>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.imageInterpreterDescription')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect
          value={providerId}
          onValueChange={(selectedValue) => {
            const next = selectedValue
            setProviderId(next)
            setModelId('')
            setManual(false)
            setMeta(null)
            setEffort('off')
            if (!next) commit('', '', 'off')
          }}
          className="h-8 w-auto max-w-full text-[13px]"
        >
          <SelectOption value="">{t('settings.imageInterpreterOff')}</SelectOption>
          {connectedProviders.map((p) => (
            <SelectOption key={p.id} value={p.id}>
              {p.name}
            </SelectOption>
          ))}
        </OptionSelect>
        {providerId &&
          (manual ? (
            <input
              className={cn(inputCls, 'min-w-[220px] flex-1')}
              placeholder={t('settings.modelIdPlaceholder')}
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              onBlur={() => commit(providerId, modelId.trim(), effort)}
            />
          ) : (
            <OptionSelect
              value={modelId}
              disabled={loading}
              onValueChange={(selectedValue) => {
                if (selectedValue === '__manual__') {
                  setManual(true)
                  setModelId('')
                  return
                }
                setModelId(selectedValue)
                setEffort('off')
                commit(providerId, selectedValue, 'off')
              }}
              className="h-8 w-auto max-w-full text-[13px]"
            >
              <SelectOption value="">{loading ? t('settings.loadingModels') : t('settings.chooseModel')}</SelectOption>
              {modelId && !models.includes(modelId) && <SelectOption value={modelId}>{modelId}</SelectOption>}
              {models.map((m) => (
                <SelectOption key={m} value={m}>
                  {m}
                </SelectOption>
              ))}
              <SelectOption value="__manual__">{t('settings.enterIdManually')}</SelectOption>
            </OptionSelect>
          ))}
        {providerId && modelId && meta?.reasoning && (
          <OptionSelect
            value={efforts.includes(effort) ? effort : 'off'}
            onValueChange={(selectedValue) => {
              setEffort(selectedValue)
              commit(providerId, modelId, selectedValue)
            }}
            className="h-8 w-auto max-w-full text-[13px]"
            title={t('reasoning.buttonTitle')}
          >
            <SelectOption value="off">{t('reasoning.default')}</SelectOption>
            {efforts.map((eff) => (
              <SelectOption key={eff} value={eff}>
                {eff}
              </SelectOption>
            ))}
          </OptionSelect>
        )}
      </div>
      {providerId && modelId && meta?.vision === false && (
        <p className="text-[11px] text-amber-300">{t('settings.imageInterpreterNoVisionWarning')}</p>
      )}
    </div>
  )
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

function McpAddForm({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const r = await api.chatMcpAdd(
      transport === 'http'
        ? {
            name: name.trim(),
            transport,
            url: url.trim(),
            headers: headers.trim() ? parseHeaders(headers) : undefined,
          }
        : {
            name: name.trim(),
            transport,
            command: command.trim(),
            args: args.trim() ? args.trim().split(/\s+/) : undefined,
            env: env.trim() ? parseEnv(env) : undefined,
          }
    )
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? t('settings.errAddFailed'))
      return
    }
    onAdded()
  }

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-white/[0.02] px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-medium text-foreground">{t('settings.newMcpServer')}</span>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <input
          className={inputCls}
          placeholder={t('settings.mcpNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTransport('http')}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[12px]',
              transport === 'http' ? 'border-ring bg-white/5 text-foreground' : 'border-border text-muted-foreground'
            )}
          >
            HTTP
          </button>
          <button
            type="button"
            onClick={() => setTransport('stdio')}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[12px]',
              transport === 'stdio' ? 'border-ring bg-white/5 text-foreground' : 'border-border text-muted-foreground'
            )}
          >
            stdio
          </button>
        </div>
        {transport === 'http' ? (
          <>
            <input
              className={inputCls}
              placeholder={t('settings.mcpUrlPlaceholder')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <textarea
              className={cn(inputCls, 'min-h-[56px] font-mono text-[12px]')}
              placeholder={t('settings.mcpHeadersPlaceholder')}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
            />
          </>
        ) : (
          <>
            <input
              className={inputCls}
              placeholder={t('settings.mcpCommandPlaceholder')}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            <input
              className={inputCls}
              placeholder={t('settings.mcpArgsPlaceholder')}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
            <textarea
              className={cn(inputCls, 'min-h-[44px] font-mono text-[12px]')}
              placeholder={t('settings.mcpEnvPlaceholder')}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            />
          </>
        )}
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-white/5"
          >
            {t('settings.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !name.trim() || (transport === 'http' ? !url.trim() : !command.trim())}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-[12px] font-medium',
              name.trim() ? 'bg-indigo-500 text-white hover:bg-indigo-400' : 'bg-foreground/10 text-muted-foreground'
            )}
          >
            {t('settings.add')}
          </button>
        </div>
      </div>
    </div>
  )
}

function McpSettings({ servers, onChanged }: { servers: McpServerInfo[]; onChanged: () => void }) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [adding, setAdding] = useState(false)
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <div>
        <span className="text-[12px] font-medium text-foreground">{t('settings.mcpServersHeading')}</span>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.mcpServersDescription')}</p>
      </div>
      {servers.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-[13px]"
        >
          <button
            type="button"
            onClick={() => api.chatMcpUpdate(s.id, { enabled: !s.enabled }).then(onChanged)}
            className={cn(
              'h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors',
              s.enabled ? 'bg-emerald-500/70' : 'bg-white/10'
            )}
            title={s.enabled ? t('settings.toggleOn') : t('settings.toggleOff')}
          >
            <span
              className={cn('block h-3 w-3 rounded-full bg-white transition-transform', s.enabled && 'translate-x-3')}
            />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-foreground">{s.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {s.transport === 'http' ? s.url : s.command}
            </div>
            {s.unavailable && <p className="text-[11px] text-destructive">{t('mcp.unavailable')}</p>}
          </div>
          <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {s.transport}
          </span>
          <button
            type="button"
            onClick={() => api.chatMcpRemove(s.id).then(onChanged)}
            className="shrink-0 text-muted-foreground hover:text-destructive"
            title={t('settings.remove')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {adding ? (
        <McpAddForm
          onAdded={() => {
            setAdding(false)
            onChanged()
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-foreground hover:bg-white/5"
        >
          <Plus className="h-3.5 w-3.5" /> {t('settings.addMcpServer')}
        </button>
      )}
    </div>
  )
}
