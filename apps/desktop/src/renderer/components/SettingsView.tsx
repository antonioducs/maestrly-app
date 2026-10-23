/** Desktop preferences and provider integrations. Local performance diagnostics remain available
 * without uploading telemetry or coupling settings to a Maestrly account. */
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings, X } from 'lucide-react'
import type { ChatPermMode, ShortcutOpenMode } from '../../preload'
import { UsagePanel } from '@/components/UsagePanel'
import { hostApi, HostProvider, useHostApi } from '@/lib/hosts/host-context'
import { useHosts } from '@/lib/hosts/use-hosts'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { type HostId, LOCAL_HOST_ID } from '../../shared/host-key'
import { useLocale } from '@/lib/i18n'
import type { FloatTab } from '../../shared/tool-tabs'
import {
  defaultShortcuts,
  defaultClosePopup,
  defaultDrawerShortcut,
  isValidBinding,
  eventKey,
  type ShortcutMod,
  type ShortcutOs,
  type ShortcutBinding,
  type EffectiveShortcuts,
} from '../../shared/shortcuts'
import { DEFAULT_SOUND_SETTINGS, type SoundEvent, type SoundSettings, type SoundVoice } from '../../shared/sound'
import { Button } from '@/components/ui/button'
import { useReorder } from '@/lib/use-reorder'
import {
  DEFAULT_MAIN_ORDER,
  mainTabsForFeatures,
  reorderVisibleTabs,
  sanitizeMainOrder,
  type DrawerTab,
} from '@/lib/drawer-tabs'
import { cn } from '@/lib/utils'
import { SETTINGS_NAV, type SettingsSection } from '@/components/settings/nav'
import { MaestrlyChatSection } from '@/components/settings/MaestrlyChatSection'
import type { ChatSettingsOptions } from '@/components/chat/chat-settings-tabs'
import type { SettingsRequest } from '@/lib/use-settings'
import { AgentActivitySection, LanguageSection, SoundSection } from '@/components/settings/AppearanceSections'
import { TabOrderSection } from '@/components/settings/TabOrderSection'
import { ShortcutsSection } from '@/components/settings/ShortcutsSection'
import { TerminalShellSection, WIN_SHELL_IDS } from '@/components/settings/TerminalShellSection'
import { DefaultPermissionSection, ProjectsDirectorySection } from '@/components/settings/ExecutionSections'
import { PrivacySection } from '@/components/settings/PrivacySection'
import { UpdatesSection } from '@/components/settings/UpdatesSection'
import { FleetSettings } from '@/components/settings/FleetSettings'
import { ComputersSection } from '@/components/settings/computers/ComputersSection'
import { ArtifactsSettings, type BotServerSetupChoice } from '@/components/settings/ArtifactsSettings'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { FleetServerId, FleetServerView } from '../../shared/fleet-servers'

/** The sections about a Maestrly profile, which a host has; the others are this computer's window and app. */
const PROFILE_SECTIONS: ReadonlySet<SettingsSection> = new Set(['chat', 'usage', 'execution'])

interface Props {
  /** The paired bot servers; Settings → Bot servers starts on `botsServer`, the one the Bots tab shows. */
  fleets?: { servers: FleetServerView[]; controller(serverId: FleetServerId): FleetController }
  botsServer?: FleetServerId
  initialSection?: SettingsSection
  /** Sections to offer, in the nav's order; all by default. With a single one, the section list is not shown. */
  sections?: readonly SettingsSection[]
  /** Chat settings subset (a bot's own Maestrly). */
  chat?: ChatSettingsOptions
  /** A place to show, such as Chat → Plugins on the host of the conversation that asked. */
  request?: SettingsRequest | null
  /** Leaves Settings to show a paired computer's lists; without it, Settings → Computers is not offered. */
  onOpenHost?: (hostId: HostId) => void

  onClose: () => void
}

export function SettingsView({
  fleets,
  botsServer,
  initialSection = 'chat',
  sections,
  chat,
  request,
  onOpenHost,
  onClose,
}: Props) {
  const { t } = useTranslation('ui')
  const api = useHostApi()
  // Sections about a Maestrly profile (its chat, bots, platform, usage and execution settings) show the profile of
  // the chosen host; the others are this computer's window and app, whichever host is chosen.
  const hosts = useHosts()
  const profileHosts = hosts.filter((host) => !host.remote || host.state === 'online')
  const [profileHostId, setProfileHostId] = useState<HostId>(LOCAL_HOST_ID)
  const profileHost = profileHosts.find((host) => host.id === profileHostId) ?? profileHosts[0]
  const profileApi = hostApi(profileHost.id)
  const inProfile = (node: ReactNode) => (
    // Mounted again for another host, and for a host that answers again.
    <HostProvider key={`${profileHost.id}:${profileHost.epoch}`} hostId={profileHost.id}>
      {node}
    </HostProvider>
  )
  const navItems = (sections ? SETTINGS_NAV.filter((item) => sections.includes(item.id)) : SETTINGS_NAV).filter(
    (item) => item.id !== 'computers' || onOpenHost
  )
  const showNav = navItems.length > 1
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [locale, setLocale] = useLocale()
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<ChatPermMode>('full')

  const isWin = window.api.platformInfo.os === 'win'
  const [freeShell, setFreeShell] = useState('auto')
  const [customShell, setCustomShell] = useState('')
  const [shellTesting, setShellTesting] = useState(false)
  const [shellTest, setShellTest] = useState<{ ok: boolean; error?: string } | null>(null)

  const [sound, setSound] = useState<SoundSettings>(DEFAULT_SOUND_SETTINGS)

  const [shortcuts, setShortcutsState] = useState<EffectiveShortcuts | null>(null)
  const [shortcutsOs, setShortcutsOs] = useState<ShortcutOs>('mac')
  const [closeShortcut, setCloseShortcutState] = useState<ShortcutBinding | null>(null)
  const [drawerShortcut, setDrawerShortcutState] = useState<ShortcutBinding | null>(null)
  const [openMode, setOpenModeState] = useState<ShortcutOpenMode>('popup')

  const [recording, setRecording] = useState<FloatTab | 'drawer' | null>(null)
  const [chatGptWebEnabled, setChatGptWebEnabled] = useState(false)

  const [tabOrder, setTabOrder] = useState<DrawerTab[]>(DEFAULT_MAIN_ORDER)

  const [section, setSection] = useState<SettingsSection>(initialSection)
  // Set when Settings → Artifacts sends the owner to set up a bot server, so its setup opens on that choice.
  const [fleetSetup, setFleetSetup] = useState<BotServerSetupChoice | null>(null)

  useEffect(() => {
    setSection(initialSection)
    if (initialSection === 'chat') headingRef.current?.focus()
  }, [initialSection])
  useEffect(() => {
    if (!request) return
    setSection(request.section)
    if (request.hostId && profileHosts.some((host) => host.id === request.hostId)) setProfileHostId(request.hostId)
  }, [request?.seq])
  const chatOptions: ChatSettingsOptions | undefined = request?.chatTab
    ? { ...chat, requestedTab: { tab: request.chatTab, seq: request.seq } }
    : chat

  useEffect(() => {
    profileApi
      .getDefaultPermissionMode()
      .then(setDefaultPermissionMode)
      .catch(() => {})
  }, [profileApi])

  useEffect(() => {
    if (isWin) {
      api
        .getFreeTerminalShell()
        .then((v) => {
          const known = WIN_SHELL_IDS.includes(v) && v !== 'custom'
          if (known) setFreeShell(v)
          else {
            setFreeShell('custom')
            setCustomShell(v)
          }
        })
        .catch(() => {})
    }
    window.api
      .getSoundSettings()
      .then(setSound)
      .catch(() => {})
    window.api
      .getDefaultMainTabOrder()
      .then((o) => setTabOrder(o ? sanitizeMainOrder(o) : DEFAULT_MAIN_ORDER))
      .catch(() => {})

    return () => {}
  }, [isWin, api])

  useEffect(() => {
    window.api
      .getShortcuts()
      .then((s) => {
        setShortcutsState(s.shortcuts)
        setShortcutsOs(s.os)
        setCloseShortcutState(s.close)
        setDrawerShortcutState(s.drawer)
        setOpenModeState(s.openMode)
      })
      .catch(() => {})
    return window.api.onShortcutsChanged((s) => {
      setShortcutsState(s.shortcuts)
      setShortcutsOs(s.os)
      setCloseShortcutState(s.close)
      setDrawerShortcutState(s.drawer)
      setOpenModeState(s.openMode)
    })
  }, [])

  useEffect(() => {
    let alive = true
    const apply = (status: { enabled: boolean }) => {
      if (!alive) return
      setChatGptWebEnabled(status.enabled)
      if (!status.enabled) setRecording((current) => (current === 'chatgpt' ? null : current))
    }
    void api
      .chatGptWebStatus()
      .then(apply)
      .catch(() => setChatGptWebEnabled(false))
    const off = api.onChatGptWebStatus(apply)
    return () => {
      alive = false
      off()
    }
  }, [api])

  const persistShortcuts = (next: EffectiveShortcuts) => {
    setShortcutsState(next)
    window.api.setShortcuts(next)
  }
  const disableShortcut = (tab: FloatTab) => {
    if (shortcuts) persistShortcuts({ ...shortcuts, [tab]: null })
  }
  const resetShortcuts = () => {
    setShortcutsState(defaultShortcuts(shortcutsOs))
    window.api.setShortcuts({})
    const closeDefault = defaultClosePopup(shortcutsOs)
    setCloseShortcutState(closeDefault)
    window.api.setCloseShortcut(closeDefault)
    const drawerDefault = defaultDrawerShortcut(shortcutsOs)
    setDrawerShortcutState(drawerDefault)
    window.api.setDrawerShortcut(drawerDefault)
  }

  useEffect(() => {
    if (!recording || !shortcuts) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const mods: ShortcutMod[] = []
      if (e.metaKey) mods.push('meta')
      if (e.ctrlKey) mods.push('control')
      if (e.altKey) mods.push('alt')
      if (e.shiftKey) mods.push('shift')
      const key = eventKey({ key: e.key, code: e.code })
      if (!key) return
      const binding = { key, mods }
      if (!isValidBinding(binding)) return
      if (recording === 'drawer') {
        setDrawerShortcutState(binding)
        window.api.setDrawerShortcut(binding)
      } else {
        persistShortcuts({ ...shortcuts, [recording]: binding })
      }
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, shortcuts])

  const updateDefaultPermissionMode = (mode: ChatPermMode) => {
    setDefaultPermissionMode(mode)
    profileApi.setDefaultPermissionMode(mode)
  }

  const selectShell = (id: string) => {
    setFreeShell(id)
    setShellTest(null)
    if (id !== 'custom') api.setFreeTerminalShell(id)
    else if (customShell.trim()) api.setFreeTerminalShell(customShell.trim())
  }

  const commitCustomShell = () => {
    if (freeShell === 'custom' && customShell.trim()) api.setFreeTerminalShell(customShell.trim())
  }

  const testShell = async () => {
    const value = freeShell === 'custom' ? customShell.trim() : freeShell
    if (!value) return
    setShellTesting(true)
    setShellTest(null)
    try {
      setShellTest(await api.testFreeTerminalShell(value))
    } catch (e) {
      setShellTest({ ok: false, error: String((e as Error)?.message ?? e) })
    } finally {
      setShellTesting(false)
    }
  }

  const updateSound = (patch: (cur: SoundSettings) => SoundSettings) => {
    setSound((cur) => {
      const next = patch(cur)
      window.api.setSoundSettings(next)
      return next
    })
  }

  const toggleSoundMute = () => updateSound((cur) => ({ ...cur, muted: !cur.muted }))

  const toggleBotSounds = () => updateSound((cur) => ({ ...cur, bots: !cur.bots }))

  const toggleNotifications = () => updateSound((cur) => ({ ...cur, notifications: !cur.notifications }))

  const setMasterVolume = (v: number) => updateSound((cur) => ({ ...cur, volume: v }))

  const setEventVoice = (event: SoundEvent, voice: SoundVoice) => {
    updateSound((cur) => ({ ...cur, events: { ...cur.events, [event]: voice } }))
    window.api.previewSound(voice, sound.volume * sound.volumes[event])
  }

  const toggleEventMute = (event: SoundEvent) =>
    updateSound((cur) => {
      const muted = !cur.mutedEvents[event]
      const next = { ...cur, mutedEvents: { ...cur.mutedEvents, [event]: muted } }
      if (!muted) window.api.previewSound(next.events[event], next.volume * next.volumes[event])
      return next
    })

  const setEventVolume = (event: SoundEvent, v: number) =>
    updateSound((cur) => ({ ...cur, volumes: { ...cur.volumes, [event]: v } }))

  const previewEventVolume = (event: SoundEvent, v: number) =>
    window.api.previewSound(sound.events[event], sound.volume * v)

  const visibleTabOrder = mainTabsForFeatures(tabOrder, chatGptWebEnabled)
  const reorderTab = (from: number, to: number) =>
    setTabOrder((cur) => {
      const next = reorderVisibleTabs(cur, mainTabsForFeatures(cur, chatGptWebEnabled), from, to)
      if (next === cur) return cur
      window.api.setDefaultMainTabOrder(next)
      return next
    })
  const { props: tabDragProps, overIndex: tabOverIndex } = useReorder(reorderTab)

  const resetTabOrder = () => {
    setTabOrder(DEFAULT_MAIN_ORDER)
    window.api.setDefaultMainTabOrder(DEFAULT_MAIN_ORDER)
  }

  const selectSection = (next: SettingsSection) => {
    if (next !== 'tools') setRecording(null)
    setSection(next)
    setFleetSetup(null)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-10 shrink-0 items-center gap-2 hairline-b pl-[var(--view-header-inset)] pr-3">
        <Settings className="size-4 text-muted-foreground" />
        <h1 ref={headingRef} tabIndex={-1} className="truncate text-[13px] font-medium text-foreground/90 outline-none">
          {t('settings.title')}
        </h1>
        <Button
          variant="ghost"
          size="icon"
          className="no-drag ml-auto size-7"
          onClick={onClose}
          title={t('common.close')}
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {showNav && (
          <nav className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectSection(item.id)}
                aria-pressed={section === item.id}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors',
                  section === item.id
                    ? 'bg-white/[0.06] text-foreground'
                    : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground'
                )}
              >
                <span className="shrink-0 text-muted-foreground">{item.icon}</span>
                <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              'mx-auto flex w-full flex-col gap-7 px-6 py-6',
              section === 'chat' ? 'max-w-6xl' : 'max-w-2xl'
            )}
          >
            {PROFILE_SECTIONS.has(section) && profileHosts.length > 1 && (
              <div data-settings-host className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span id="settings-host-label" className="text-[13px] font-medium">
                  {t('settings.host.label')}
                </span>
                <OptionSelect
                  value={profileHost.id}
                  onValueChange={setProfileHostId}
                  aria-labelledby="settings-host-label"
                  className="h-8 w-60"
                >
                  {profileHosts.map((host) => (
                    <SelectOption key={host.id} value={host.id}>
                      {host.remote ? host.label || t('sidebar.hostUnnamed') : t('sidebar.hostThisComputer')}
                    </SelectOption>
                  ))}
                </OptionSelect>
                <p className="basis-full text-xs text-muted-foreground">{t('settings.host.hint')}</p>
              </div>
            )}

            {section === 'usage' && inProfile(<UsagePanel />)}

            {section === 'appearance' && <LanguageSection t={t} locale={locale} setLocale={setLocale} />}
            {section === 'appearance' && <AgentActivitySection t={t} />}

            {section === 'tools' && (
              <TabOrderSection
                t={t}
                tabOrder={visibleTabOrder}
                tabDragProps={tabDragProps}
                tabOverIndex={tabOverIndex}
                resetTabOrder={resetTabOrder}
              />
            )}

            {section === 'chat' && inProfile(<MaestrlyChatSection t={t} chat={chatOptions} />)}

            {section === 'artifacts' && (
              <ArtifactsSettings
                onOpenFleet={() => selectSection('fleet')}
                onSetupServer={(choice) => {
                  selectSection('fleet')
                  setFleetSetup(choice)
                }}
              />
            )}
            {section === 'computers' && onOpenHost && <ComputersSection request={request} onOpenHost={onOpenHost} />}
            {section === 'fleet' && fleets && (
              <FleetSettings
                fleets={fleets}
                initialServer={botsServer}
                request={request?.fleetServer ? { server: request.fleetServer, seq: request.seq } : null}
                {...(fleetSetup ? { initialSetup: fleetSetup, defaultHosts: 'artifacts-only' } : {})}
              />
            )}

            {section === 'execution' && (
              <DefaultPermissionSection t={t} mode={defaultPermissionMode} onChange={updateDefaultPermissionMode} />
            )}
            {section === 'execution' &&
              !window.api.platformInfo.botMode &&
              inProfile(<ProjectsDirectorySection t={t} />)}

            {section === 'appearance' && (
              <SoundSection
                t={t}
                sound={sound}
                toggleSoundMute={toggleSoundMute}
                toggleBotSounds={toggleBotSounds}
                toggleNotifications={toggleNotifications}
                setMasterVolume={setMasterVolume}
                setEventVoice={setEventVoice}
                toggleEventMute={toggleEventMute}
                setEventVolume={setEventVolume}
                previewEventVolume={previewEventVolume}
              />
            )}

            {section === 'tools' && shortcuts && (
              <ShortcutsSection
                t={t}
                shortcuts={shortcuts}
                shortcutsOs={shortcutsOs}
                closeShortcut={closeShortcut}
                drawerShortcut={drawerShortcut}
                openMode={openMode}
                recording={recording}
                setRecording={setRecording}
                setOpenModeState={setOpenModeState}
                setCloseShortcutState={setCloseShortcutState}
                disableShortcut={disableShortcut}
                resetShortcuts={resetShortcuts}
                chatGptWebEnabled={chatGptWebEnabled}
              />
            )}

            {section === 'tools' && isWin && (
              <TerminalShellSection
                t={t}
                freeShell={freeShell}
                customShell={customShell}
                setCustomShell={setCustomShell}
                shellTesting={shellTesting}
                shellTest={shellTest}
                selectShell={selectShell}
                commitCustomShell={commitCustomShell}
                testShell={testShell}
              />
            )}

            {section === 'privacy' && <PrivacySection t={t} />}

            {section === 'updates' && <UpdatesSection t={t} />}
          </div>
        </div>
      </div>
    </div>
  )
}
