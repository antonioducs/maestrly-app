import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, ImageIcon, Bot, ExternalLink, Loader2, ArrowLeft, Shield, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatConfig, ChatGptWebCapabilitiesInfo, ChatMode } from '../../../shared/chat'
import { ConversationSubagentProfiles } from './subagent-profiles/ConversationSubagentProfiles'
import { notifySubagentProfilesChanged } from '@/lib/subagent-catalog-events'
import { startChatGptWebCompanion } from '@/lib/chatgpt-web'
import { ChatGptWebAccessEditor } from './ChatGptWebAccessEditor'

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
  onCompanionStarting,
}: {
  conversationId: string
  mode: ChatMode
  onAddFiles: (files: File[]) => void
  fontScale: number
  onFontScale: (n: number) => void
  onCompanionStarting: (starting: boolean) => void
}) {
  const { t } = useTranslation('chat')
  const [activePanel, setActivePanel] = useState<'menu' | 'subagents' | 'companion' | null>(null)
  const [config, setConfig] = useState<ChatConfig | null>(null)
  const [app, setApp] = useState(false)
  const [imageGen, setImageGen] = useState(true)
  const [mcpDisabled, setMcpDisabled] = useState<string[]>([])
  const [subagentProfilesEnabled, setSubagentProfilesEnabled] = useState(true)
  const [subagentsEnabled, setSubagentsEnabled] = useState(true)
  const [companionBusy, setCompanionBusy] = useState(false)
  const [companionError, setCompanionError] = useState<string | null>(null)
  const [chatGptWebEnabled, setChatGptWebEnabled] = useState(false)
  const [companionCapabilities, setCompanionCapabilities] = useState<ChatGptWebCapabilitiesInfo | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const conversationIdRef = useRef(conversationId)
  const subagentProfilesRevisionRef = useRef(0)
  const subagentsRevisionRef = useRef(0)
  conversationIdRef.current = conversationId

  const loadTools = () => {
    const targetConversationId = conversationId
    window.api.chatConfig().then(setConfig)
    window.api.chatGetConvTools(targetConversationId).then((t) => {
      if (conversationIdRef.current !== targetConversationId) return
      setApp(t.app)
      setImageGen(t.imageGen)
      setMcpDisabled(t.mcpDisabled)
    })
    window.api.chatGptWebCapabilities(targetConversationId).then((value) => {
      if (conversationIdRef.current === targetConversationId) setCompanionCapabilities(value)
    })
    const profilesRevision = subagentProfilesRevisionRef.current
    const subagentsRevision = subagentsRevisionRef.current
    window.api.chatSubagentProfilesGetConversation(targetConversationId).then((payload) => {
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
  }, [conversationId])

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
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [activePanel])

  useEffect(() => setActivePanel(null), [conversationId])

  useEffect(() => {
    let alive = true
    const apply = (status: { enabled: boolean }) => {
      if (!alive) return
      setChatGptWebEnabled(status.enabled)
      if (!status.enabled) setCompanionError(null)
    }
    void window.api
      .chatGptWebStatus()
      .then(apply)
      .catch(() => setChatGptWebEnabled(false))
    const off = window.api.onChatGptWebStatus(apply)
    return () => {
      alive = false
      off()
    }
  }, [])

  const toggleApp = () => {
    const next = !app
    setApp(next)
    window.api.chatSetConvTools(conversationId, { app: next })
  }

  const toggleImageGen = () => {
    const next = !imageGen
    setImageGen(next)
    window.api.chatSetConvTools(conversationId, { imageGen: next })
  }
  const toggleMcp = (id: string) => {
    const next = mcpDisabled.includes(id) ? mcpDisabled.filter((x) => x !== id) : [...mcpDisabled, id]
    setMcpDisabled(next)
    window.api.chatSetConvTools(conversationId, { mcpDisabled: next })
  }
  const toggleSubagentProfiles = () => {
    const targetConversationId = conversationId
    const profilesRevision = ++subagentProfilesRevisionRef.current
    const previous = subagentProfilesEnabled
    const next = !previous
    setSubagentProfilesEnabled(next)
    void window.api.chatSubagentProfilesSetConversationEnabled(targetConversationId, next).then((result) => {
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
    void window.api.chatSubagentsSetConversationEnabled(targetConversationId, next).then((result) => {
      if (result.ok) notifySubagentProfilesChanged()
      if (conversationIdRef.current !== targetConversationId || subagentsRevisionRef.current !== revision) return
      setSubagentsEnabled(result.ok ? result.value.subagentsEnabled : previous)
    })
  }

  const startChatGptCompanion = async () => {
    setCompanionBusy(true)
    onCompanionStarting(true)
    setCompanionError(null)
    try {
      if (companionCapabilities?.editable) {
        const saved = await window.api.chatGptWebSetCapabilities(conversationId, companionCapabilities.capabilities)
        setCompanionCapabilities(saved)
      }
      await startChatGptWebCompanion(conversationId)
      setActivePanel(null)
    } catch (cause) {
      setCompanionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCompanionBusy(false)
      onCompanionStarting(false)
    }
  }

  const saveCompanionCapabilities = async () => {
    if (!companionCapabilities?.editable) return
    setCompanionBusy(true)
    setCompanionError(null)
    try {
      setCompanionCapabilities(
        await window.api.chatGptWebSetCapabilities(conversationId, companionCapabilities.capabilities)
      )
    } catch (cause) {
      setCompanionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCompanionBusy(false)
    }
  }

  const servers = config?.mcpServers ?? []

  return (
    <div className="relative" ref={ref}>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/*,text/*,.md,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.css,.html,.yml,.yaml,.toml,.sh,.sql"
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
          className="absolute bottom-full left-0 z-50 mb-1 w-72 overflow-hidden rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl"
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
          {chatGptWebEnabled && (
            <button
              type="button"
              disabled={companionBusy}
              onClick={() => setActivePanel('companion')}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-foreground hover:bg-white/[0.05] disabled:opacity-50"
            >
              {companionBusy ? (
                <Loader2 className="h-4 w-4 animate-spin text-violet-300" />
              ) : (
                <ExternalLink className="h-4 w-4 text-violet-300" />
              )}
              <span className="min-w-0">
                <span className="block">{t('plusMenu.chatgptCompanion')}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {t('plusMenu.chatgptCompanionDesc')}
                </span>
              </span>
            </button>
          )}
          {chatGptWebEnabled && companionError && (
            <div className="mx-2.5 mb-1 rounded border border-amber-500/25 bg-amber-500/[0.07] px-2 py-1 text-[11px] text-amber-200">
              {t('plusMenu.chatgptCompanionError', { error: companionError })}
            </div>
          )}
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

          <div className="my-1 border-t border-white/[0.06]" />
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

          <div className="my-1 border-t border-white/[0.06]" />
          {(mode === 'plan' || mode === 'ask') && (
            <div className="rounded-md bg-white/[0.04] px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
              {t(`plusMenu.restrictedMode.${mode}`)}
            </div>
          )}
          {(mode === 'plan' || mode === 'ask') && <div className="my-1 border-t border-white/[0.06]" />}
          <div className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5">
            <div className="min-w-0">
              <div className="text-[13px] text-foreground">{t('plusMenu.appToolsLabel')}</div>
              <div className="text-[11px] text-muted-foreground">{t('plusMenu.appToolsDesc')}</div>
            </div>
            <Toggle on={app} onClick={toggleApp} label={t('plusMenu.appToolsLabel')} />
          </div>
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
                  {!s.enabled && <div className="text-[11px] text-amber-400/80">{t('plusMenu.disabledGlobally')}</div>}
                </div>
                <Toggle on={on} onClick={() => s.enabled && toggleMcp(s.id)} label={s.name} />
              </div>
            )
          })}
          <div className="mt-1 border-t border-white/[0.06] px-2.5 pt-1.5 text-[11px] text-muted-foreground">
            {t('plusMenu.settingsHint')}
          </div>
        </div>
      )}
      {activePanel === 'subagents' && (
        <ConversationSubagentProfiles
          conversationId={conversationId}
          returnFocusRef={triggerRef}
          onClose={() => setActivePanel(null)}
        />
      )}
      {activePanel === 'companion' && (
        <div className="absolute bottom-full left-0 z-50 mb-1 max-h-[min(80vh,42rem)] w-96 overflow-y-auto rounded-lg border border-white/[0.1] bg-[#161618] p-2 shadow-2xl">
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActivePanel('menu')}
              className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              aria-label={t('plusMenu.companionBack')}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <Shield className="h-4 w-4 text-violet-300" />
            <div className="text-[13px] font-medium text-foreground">{t('plusMenu.companionAccess')}</div>
          </div>
          {!companionCapabilities ? (
            <div className="flex items-center gap-2 px-2 py-4 text-[12px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('plusMenu.companionLoading')}
            </div>
          ) : (
            <>
              <ChatGptWebAccessEditor
                info={companionCapabilities}
                capabilities={companionCapabilities.capabilities}
                editable={companionCapabilities.editable}
                disabled={companionBusy}
                onChange={(capabilities) =>
                  setCompanionCapabilities((current) => (current ? { ...current, capabilities } : current))
                }
                variant="compact"
              />
              {companionError && <div className="mt-2 text-[11px] text-amber-300">{companionError}</div>}
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={companionBusy || !companionCapabilities.editable}
                  onClick={() => void saveCompanionCapabilities()}
                  className="rounded border border-white/15 px-2.5 py-1 text-[11px] text-foreground hover:bg-white/[0.05] disabled:opacity-40"
                >
                  {t('plusMenu.companionSave')}
                </button>
                <button
                  type="button"
                  disabled={companionBusy}
                  onClick={() => void startChatGptCompanion()}
                  className="inline-flex items-center gap-1 rounded bg-violet-600 px-2.5 py-1 text-[11px] text-white hover:bg-violet-500 disabled:opacity-50"
                >
                  {companionBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t('plusMenu.companionStart')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
