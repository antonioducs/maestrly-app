import { useChatDocument } from '@/lib/chat-window-context'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, ImageIcon, Bot, SlidersHorizontal, ChevronRight, Puzzle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatConfig, ChatConvTools, ChatMode } from '../../../shared/chat'
import { APP_TOOL_GROUPS, type AppToolGroup, type AppToolGroupState } from '../../../shared/app-tool-groups'
import { ConversationSubagentProfiles } from './subagent-profiles/ConversationSubagentProfiles'
import { notifySubagentProfilesChanged } from '@/lib/subagent-catalog-events'
import { useHostApi, useHostId } from '@/lib/hosts/host-context'
import { useSettings } from '@/lib/use-settings'
import { localChatComposerSource, type ChatComposerSource } from './chat-composer-source'

function Toggle({
  on,
  onClick,
  label,
  disabled = false,
}: {
  on: boolean
  onClick: () => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-label={label}
      aria-checked={on}
      role="switch"
      disabled={disabled}
      className={cn(
        'h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        on ? 'bg-emerald-500/70' : 'bg-white/10'
      )}
    >
      <span className={cn('block h-3 w-3 rounded-full bg-white transition-transform', on && 'translate-x-3')} />
    </button>
  )
}

export function ChatPlusMenu({
  conversationId,
  mode,
  onAddFiles,
  fontScale,
  onFontScale,
  source: providedSource,
  manageMcpLabel,
}: {
  conversationId: string
  mode: ChatMode
  onAddFiles: (files: File[]) => void
  fontScale: number
  onFontScale: (n: number) => void
  source?: ChatComposerSource
  manageMcpLabel?: string
}) {
  const ownerDocument = useChatDocument()
  const { t } = useTranslation('chat')
  const { t: tp } = useTranslation('plugins')
  const api = useHostApi()
  const hostId = useHostId()
  const { openSettings } = useSettings()
  const source = providedSource ?? localChatComposerSource(api, conversationId)
  const [activePanel, setActivePanel] = useState<'menu' | 'subagents' | null>(null)
  const [config, setConfig] = useState<Pick<ChatConfig, 'mcpServers' | 'appToolsEnabled' | 'imageGenEnabled'> | null>(
    null
  )
  const [app, setApp] = useState(false)
  const [appGroups, setAppGroups] = useState<AppToolGroupState | null>(null)
  const [appGroupsOpen, setAppGroupsOpen] = useState(false)
  const appGroupsId = useId()
  const [imageGen, setImageGen] = useState(true)
  const [mcpDisabled, setMcpDisabled] = useState<string[]>([])
  const [pluginMcpServers, setPluginMcpServers] = useState<string[] | null>(null)
  const [mcpAccounts, setMcpAccounts] = useState<NonNullable<ChatConvTools['mcpAccounts']>>([])
  const [mcpAccountsDisabled, setMcpAccountsDisabled] = useState<string[]>([])
  const [subagentProfilesEnabled, setSubagentProfilesEnabled] = useState(true)
  const [subagentsEnabled, setSubagentsEnabled] = useState(true)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const conversationIdRef = useRef(conversationId)
  const subagentProfilesRevisionRef = useRef(0)
  const subagentsRevisionRef = useRef(0)
  conversationIdRef.current = conversationId

  const loadTools = () => {
    const targetConversationId = conversationId
    source.chatConfig().then(setConfig)
    source.chatGetConvTools().then((t) => {
      if (conversationIdRef.current !== targetConversationId) return
      setApp(t.app)
      setAppGroups(t.appGroups ?? null)
      setImageGen(t.imageGen)
      setMcpDisabled(t.mcpDisabled)
      setPluginMcpServers(t.pluginMcpServers ?? null)
      setMcpAccounts(t.mcpAccounts ?? [])
      setMcpAccountsDisabled(t.mcpAccountsDisabled ?? [])
    })
    const profilesRevision = subagentProfilesRevisionRef.current
    const subagentsRevision = subagentsRevisionRef.current
    source.chatSubagentProfilesGetConversation().then((payload) => {
      if (conversationIdRef.current !== targetConversationId) return
      if (subagentProfilesRevisionRef.current === profilesRevision) setSubagentProfilesEnabled(payload.enabled)
      if (subagentsRevisionRef.current === subagentsRevision) setSubagentsEnabled(payload.subagentsEnabled)
    })
  }
  useEffect(() => {
    subagentProfilesRevisionRef.current += 1
    subagentsRevisionRef.current += 1
    setSubagentProfilesEnabled(true)
    setSubagentsEnabled(true)
    loadTools()
  }, [api, conversationId])

  useEffect(() => {
    if (!activePanel) return
    if (activePanel === 'menu') loadTools()
    const onDoc = (e: MouseEvent) => {
      if (activePanel === 'subagents') return
      if (ref.current && !ref.current.contains(e.target as Node)) setActivePanel(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || activePanel === 'subagents') return
      setActivePanel(null)
    }
    ownerDocument.addEventListener('mousedown', onDoc)
    ownerDocument.addEventListener('keydown', onKey)
    return () => {
      ownerDocument.removeEventListener('mousedown', onDoc)
      ownerDocument.removeEventListener('keydown', onKey)
    }
  }, [api, ownerDocument, activePanel])

  useEffect(() => {
    setActivePanel(null)
    setAppGroupsOpen(false)
  }, [conversationId])

  const toggleApp = () => {
    const next = !app
    setApp(next)
    source.chatSetConvTools({ app: next })
  }

  // Groups exist only for local conversations (bots always run with every app tool), so this bypasses `source`.
  const toggleAppGroup = (group: AppToolGroup) => {
    if (!appGroups) return
    const patch: Partial<AppToolGroupState> = {}
    patch[group] = !appGroups[group]
    setAppGroups({ ...appGroups, ...patch })
    void api.chatSetConvTools(conversationId, { appGroups: patch })
  }

  const toggleImageGen = () => {
    const next = !imageGen
    setImageGen(next)
    source.chatSetConvTools({ imageGen: next })
  }
  const toggleMcp = (id: string) => {
    const next = mcpDisabled.includes(id) ? mcpDisabled.filter((x) => x !== id) : [...mcpDisabled, id]
    setMcpDisabled(next)
    source.chatSetConvTools({ mcpDisabled: next })
  }
  // A bot's accounts serve all of its conversations; only a host's conversations turn accounts on and off.
  const toggleAccount = (serverId: string, accountId: string) => {
    const key = `${serverId}#${accountId}`
    const next = mcpAccountsDisabled.includes(key)
      ? mcpAccountsDisabled.filter((item) => item !== key)
      : [...mcpAccountsDisabled, key]
    setMcpAccountsDisabled(next)
    void api.chatSetConvTools(conversationId, { mcpAccountsDisabled: next })
  }
  const toggleSubagentProfiles = () => {
    const targetConversationId = conversationId
    const profilesRevision = ++subagentProfilesRevisionRef.current
    const previous = subagentProfilesEnabled
    const next = !previous
    setSubagentProfilesEnabled(next)
    void source.chatSubagentProfilesSetConversationEnabled(next).then((result) => {
      if (result.ok) notifySubagentProfilesChanged()
      if (
        conversationIdRef.current !== targetConversationId ||
        subagentProfilesRevisionRef.current !== profilesRevision
      )
        return
      setSubagentProfilesEnabled(result.ok ? result.value.enabled : previous)
    })
  }

  const toggleSubagents = () => {
    const targetConversationId = conversationId
    const revision = ++subagentsRevisionRef.current
    const previous = subagentsEnabled
    const next = !previous
    setSubagentsEnabled(next)
    void source.chatSubagentsSetConversationEnabled(next).then((result) => {
      if (result.ok) notifySubagentProfilesChanged()
      if (conversationIdRef.current !== targetConversationId || subagentsRevisionRef.current !== revision) return
      setSubagentsEnabled(result.ok ? result.value.subagentsEnabled : previous)
    })
  }

  // A plugin's servers appear only in the conversations the plugin serves (its scope).
  const servers = (config?.mcpServers ?? []).filter(
    (server) => !server.plugin || !pluginMcpServers || pluginMcpServers.includes(server.id)
  )

  return (
    <div className="relative" ref={ref}>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="application/pdf,.pdf,image/*,text/*,.md,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.css,.html,.yml,.yaml,.toml,.sh,.sql"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) onAddFiles(files)
          e.target.value = ''
        }}
      />
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={activePanel !== null}
        onClick={() => setActivePanel((panel) => (panel ? null : 'menu'))}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
        title={t('plusMenu.add')}
      >
        <Plus className="h-4 w-4" />
      </button>
      {activePanel === 'menu' && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-1 max-h-[min(80vh,44rem)] w-72 overflow-y-auto rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl"
        >
          <button
            type="button"
            onClick={() => {
              setActivePanel(null)
              fileRef.current?.click()
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-foreground hover:bg-white/[0.05]"
          >
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
            {t('plusMenu.imageFile')}
          </button>
          <div className="flex items-center justify-between gap-2 rounded-md px-2.5 py-2 hover:bg-white/[0.05]">
            <div className="flex min-w-0 items-center gap-2">
              <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-[13px] text-foreground">{t('plusMenu.subagents')}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {subagentsEnabled ? t('plusMenu.subagentsEnabled') : t('plusMenu.subagentsDisabled')}
                </span>
              </span>
            </div>
            <Toggle on={subagentsEnabled} onClick={toggleSubagents} label={t('plusMenu.subagentsToggleLabel')} />
          </div>
          {!source.bot && (
            <div className="flex items-center gap-2 rounded-md hover:bg-white/[0.05]">
              <button
                type="button"
                role="menuitem"
                onClick={() => setActivePanel('subagents')}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-foreground"
              >
                <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-[13px]">{t('plusMenu.subagentProfiles')}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {subagentProfilesEnabled
                      ? t('plusMenu.subagentProfilesEnabled')
                      : t('plusMenu.subagentProfilesDisabled')}
                  </span>
                </span>
              </button>
              <div className="pr-2.5">
                <Toggle
                  on={subagentProfilesEnabled}
                  onClick={toggleSubagentProfiles}
                  label={t('subagentProfiles.toggleLabel')}
                  disabled={!subagentsEnabled}
                />
              </div>
            </div>
          )}

          {!source.bot && <div className="my-1 border-t border-white/[0.06]" />}
          {!source.bot && (
            <div className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5">
              <span className="text-[13px] text-foreground">{t('plusMenu.fontSize')}</span>
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => onFontScale(Math.max(0.8, Math.round((fontScale - 0.1) * 10) / 10))}
                  className="flex h-6 w-6 items-center justify-center rounded text-[12px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                  title={t('plusMenu.decreaseFont')}
                >
                  A−
                </button>
                <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">
                  {Math.round(fontScale * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => onFontScale(Math.min(1.6, Math.round((fontScale + 0.1) * 10) / 10))}
                  className="flex h-6 w-6 items-center justify-center rounded text-[14px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                  title={t('plusMenu.increaseFont')}
                >
                  A+
                </button>
              </div>
            </div>
          )}

          {!source.bot && <div className="my-1 border-t border-white/[0.06]" />}
          {(mode === 'plan' || mode === 'ask') && (
            <div className="rounded-md bg-white/[0.04] px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
              {t(`plusMenu.restrictedMode.${mode}`)}
            </div>
          )}
          {(mode === 'plan' || mode === 'ask') && <div className="my-1 border-t border-white/[0.06]" />}
          <div className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5">
            <div className="min-w-0">
              <div className="text-[13px] text-foreground">{t('plusMenu.appToolsLabel')}</div>
              {source.bot || !appGroups ? (
                <div className="text-[11px] text-muted-foreground">
                  {source.bot ? t('plusMenu.appToolsBotLocked') : t('plusMenu.appToolsDesc')}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAppGroupsOpen((open) => !open)}
                  aria-expanded={appGroupsOpen}
                  aria-controls={appGroupsId}
                  title={appGroupsOpen ? t('plusMenu.appToolGroupsHide') : t('plusMenu.appToolGroupsShow')}
                  className="flex max-w-full items-center gap-0.5 rounded text-left text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', appGroupsOpen && 'rotate-90')} />
                  <span className="truncate">
                    {APP_TOOL_GROUPS.every((group) => appGroups[group])
                      ? t('plusMenu.appToolsDesc')
                      : t('plusMenu.appToolGroupsSome', {
                          on: APP_TOOL_GROUPS.filter((group) => appGroups[group]).length,
                          total: APP_TOOL_GROUPS.length,
                        })}
                  </span>
                </button>
              )}
            </div>
            {/* A bot always runs with them (its browser, screen and help tools); its own Maestrly re-enables them. */}
            <Toggle
              on={source.bot ? true : app}
              onClick={toggleApp}
              label={t('plusMenu.appToolsLabel')}
              disabled={Boolean(source.bot)}
            />
          </div>
          {!source.bot && appGroups && appGroupsOpen && (
            <div id={appGroupsId} className="mb-1 ml-4 border-l border-white/[0.08] pl-1">
              {APP_TOOL_GROUPS.map((group) => {
                const label = t(`appToolGroups.${group}.label`)
                const desc = t(`appToolGroups.${group}.desc`)
                return (
                  <div
                    key={group}
                    className={cn('flex items-center justify-between gap-2 rounded-md px-2 py-1', !app && 'opacity-50')}
                    title={desc}
                  >
                    <span className="min-w-0 truncate">
                      <span className="text-[12px] text-foreground">{label}</span>
                      <span className="ml-1.5 text-[11px] text-muted-foreground">{desc}</span>
                    </span>
                    <Toggle on={appGroups[group]} onClick={() => toggleAppGroup(group)} label={label} disabled={!app} />
                  </div>
                )
              })}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5">
            <div className="min-w-0">
              <div className="text-[13px] text-foreground">{t('plusMenu.imageGenLabel')}</div>
              <div className="text-[11px] text-muted-foreground">{t('plusMenu.imageGenDesc')}</div>
            </div>
            <Toggle on={imageGen} onClick={toggleImageGen} label={t('plusMenu.imageGenLabel')} />
          </div>

          {servers.length > 0 && <div className="my-1 border-t border-white/[0.06]" />}
          {servers.length > 0 && (
            <div className="px-2.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              {t('plusMenu.mcpServers')}
            </div>
          )}
          {servers.map((s) => {
            const on = s.enabled && !mcpDisabled.includes(s.id)
            return (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-foreground">{s.name}</div>
                  {s.plugin && (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {tp('managedBy', { name: s.plugin.displayName })}
                    </div>
                  )}
                  {!s.enabled && <div className="text-[11px] text-amber-400/80">{t('plusMenu.disabledGlobally')}</div>}
                </div>
                <Toggle on={on} onClick={() => s.enabled && toggleMcp(s.id)} label={s.name} />
              </div>
            )
          })}
          {!source.bot &&
            mcpAccounts
              .filter((entry) => servers.some((server) => server.id === entry.serverId))
              .map((entry) => (
                <div key={entry.serverId} className="flex flex-col" data-mcp-accounts={entry.serverId}>
                  {entry.accounts.map((account) => {
                    const on = !mcpAccountsDisabled.includes(`${entry.serverId}#${account.id}`)
                    return (
                      <div
                        key={account.id}
                        className="flex items-center justify-between gap-2 rounded-md py-1 pl-6 pr-2.5"
                      >
                        <div className="min-w-0 truncate text-[12px] text-muted-foreground">
                          {entry.serverName} · <span className="text-foreground">{account.label}</span>
                        </div>
                        <Toggle
                          on={on}
                          onClick={() => toggleAccount(entry.serverId, account.id)}
                          label={t('plusMenu.mcpAccountLabel', { server: entry.serverName, label: account.label })}
                        />
                      </div>
                    )
                  })}
                </div>
              ))}
          {source.bot ? (
            <button
              type="button"
              onClick={() => void source.bot?.manage('mcp')}
              className="mt-1 w-full border-t border-white/[0.06] px-2.5 pt-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
            >
              {manageMcpLabel ?? t('plusMenu.settingsHint')}
            </button>
          ) : (
            <div className="mt-1 flex items-center gap-2 border-t border-white/[0.06] px-2.5 pt-1.5 text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1">{t('plusMenu.settingsHint')}</span>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setActivePanel(null)
                  openSettings('chat', { chatTab: 'plugins', hostId })
                }}
                className="inline-flex shrink-0 items-center gap-1 hover:text-foreground"
              >
                <Puzzle className="h-3.5 w-3.5" /> {tp('browsePlugins')}
              </button>
            </div>
          )}
        </div>
      )}
      {!source.bot && activePanel === 'subagents' && (
        <ConversationSubagentProfiles
          conversationId={conversationId}
          returnFocusRef={triggerRef}
          onClose={() => setActivePanel(null)}
        />
      )}
    </div>
  )
}
