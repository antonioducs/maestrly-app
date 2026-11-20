import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatConfig } from '../../../shared/chat'
import { type HostId, hostKey, LOCAL_HOST_ID } from '../../../shared/host-key'
import type { HostView } from '../../../shared/hosts'
import {
  DEFAULT_ROUTINE_SETTINGS,
  type LocalRoutine,
  type LocalRoutineRun,
  type RoutineDraft,
  type RoutineModel,
  type RoutineOrigin,
  type RoutineRunDetails,
  type RoutineRunFilter,
  type RoutineSavedPermission,
  type RoutineSettings,
  type RoutineUpdatePatch,
  storedRoutinePlace,
} from '../../../shared/routines'
import { hostApi } from '@/lib/hosts/host-context'
import { hostOfKey, hostTarget, rawId, shellConversation } from '@/lib/hosts/shell-keys'
import { chatProviderChoices } from '@/components/chat/account-pool'
import { modelDisplayName } from '@/components/chat/model-search'
import { toast } from '@/components/ui/toaster'
import {
  type HostRoutinesSnapshot,
  isRoutineHostCapable,
  mergeHostRoutines,
  shellRoutine,
  shellRoutineRun,
} from './host-routines'
import { createRoutineFromProposalOnHost, useFleetDeviceIds } from './cross-host'
import { addLocalDays, formatWhen, startOfLocalDay } from './relative-time'

export interface RoutineModelDisplayInfo {
  name: string
  providerName: string
}

export interface RemoteRoutineFolderTarget {
  hostId: HostId
  folder: string
  title: string
}

export function useRoutines({
  hosts,
  detailRoutineId,
  onNavigateAgenda,
  onNavigateRoutine,
  onOpenRemoteFolder,
}: {
  hosts: readonly HostView[]
  detailRoutineId: string | null
  onNavigateAgenda: () => void
  onNavigateRoutine: (routineId: string) => void
  onOpenRemoteFolder?: (target: RemoteRoutineFolderTarget) => void
}) {
  const { t } = useTranslation('routines')
  const deviceIdOn = useFleetDeviceIds()
  const [byHost, setByHost] = useState<Record<HostId, HostRoutinesSnapshot>>({})
  const [chatConfigByHost, setChatConfigByHost] = useState<Record<HostId, ChatConfig>>({})
  const [settings, setSettings] = useState<RoutineSettings>(DEFAULT_ROUTINE_SETTINGS)
  const [preventSleepEnabled, setPreventSleepEnabled] = useState(true)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [railDot, setRailDot] = useState(false)
  const [flashRoutineId, setFlashRoutineId] = useState<string | null>(null)
  const [startingHostIds, setStartingHostIds] = useState<Set<HostId>>(() => new Set())

  const [detailFilter, setDetailFilter] = useState<RoutineRunFilter>('all')
  const [detailLimit, setDetailLimit] = useState(10)
  const [detailRuns, setDetailRuns] = useState<LocalRoutineRun[]>([])
  const [detailTotal, setDetailTotal] = useState(0)
  const [detailHasMore, setDetailHasMore] = useState(false)
  const [savedPermissions, setSavedPermissions] = useState<RoutineSavedPermission[]>([])

  const knownRoutineIdsRef = useRef(new Map<HostId, Set<string>>())
  const sidebarTabRef = useRef<string>('workspaces')
  const flashTimerRef = useRef<number | null>(null)
  const hostsRef = useRef(hosts)
  hostsRef.current = hosts
  const byHostRef = useRef(byHost)
  byHostRef.current = byHost

  const capableHosts = useMemo(() => hosts.filter(isRoutineHostCapable), [hosts])
  const hostOrder = useMemo(() => {
    const ids = capableHosts.map((host) => host.id)
    if (!ids.includes(LOCAL_HOST_ID)) ids.unshift(LOCAL_HOST_ID)
    return ids
  }, [capableHosts])

  // Drop cached data only when a host is removed from the registry (keep offline/stopped hosts cached dimmed).
  useEffect(() => {
    const valid = new Set(hostOrder)
    setByHost((prev) => {
      let changed = false
      const next: Record<HostId, HostRoutinesSnapshot> = {}
      for (const [id, snap] of Object.entries(prev)) {
        if (valid.has(id)) next[id] = snap
        else changed = true
      }
      return changed ? next : prev
    })
    setChatConfigByHost((prev) => {
      let changed = false
      const next: Record<HostId, ChatConfig> = {}
      for (const [id, cfg] of Object.entries(prev)) {
        if (valid.has(id)) next[id] = cfg
        else changed = true
      }
      return changed ? next : prev
    })
  }, [hostOrder])

  const { routines, runsByRoutine, timelineRunsByRoutine } = useMemo(
    () => mergeHostRoutines(hostOrder, byHost, deviceIdOn),
    [hostOrder, byHost, deviceIdOn]
  )

  // A host's first snapshot brings the routines it already had: only routines added to a host seen before are new.
  useEffect(() => {
    const known = knownRoutineIdsRef.current
    let added = false
    for (const [hostId, snap] of Object.entries(byHost)) {
      const ids = new Set(snap.routines.map((item) => item.id))
      const previous = known.get(hostId)
      if (previous && [...ids].some((id) => !previous.has(id))) added = true
      known.set(hostId, ids)
    }
    if (added && sidebarTabRef.current !== 'routines') setRailDot(true)
  }, [byHost])

  const refreshHost = useCallback(async (hostId: HostId) => {
    try {
      const api = hostApi(hostId)
      const now = Date.now()
      const from = addLocalDays(startOfLocalDay(now), -2)
      const to = addLocalDays(from, 7)

      const [list, cfg, localMeta] = await Promise.all([
        api.routinesList(),
        api.chatConfig().catch(() => null),
        hostId === LOCAL_HOST_ID
          ? Promise.all([api.routinesGetSettings(), api.getPreventSleepEnabled().catch(() => true)])
          : Promise.resolve(null),
      ])

      if (localMeta) {
        setSettings(localMeta[0])
        setPreventSleepEnabled(localMeta[1])
      }
      if (cfg) {
        setChatConfigByHost((prev) => ({ ...prev, [hostId]: cfg }))
      }

      const [rangeRuns, perRoutineRuns] = await Promise.all([
        api.routinesRunsInRange(from, to),
        Promise.all(
          list.map(async (routine) => {
            const res = await api.routinesListRuns({ routineId: routine.id, filter: 'all', limit: 20 })
            return [routine.id, res.runs] as const
          })
        ),
      ])

      const hostRunsByRoutine: Record<string, LocalRoutineRun[]> = {}
      for (const [id, runs] of perRoutineRuns) hostRunsByRoutine[id] = runs

      const hostTimelineByRoutine: Record<string, LocalRoutineRun[]> = {}
      for (const run of rangeRuns) {
        ;(hostTimelineByRoutine[run.routineId] ??= []).push(run)
      }

      setByHost((prev) => ({
        ...prev,
        [hostId]: {
          routines: list,
          runsByRoutine: hostRunsByRoutine,
          timelineRunsByRoutine: hostTimelineByRoutine,
        },
      }))
    } catch {
      // Ignore transient startup/reload/offline errors; cached snapshot stays intact.
    }
  }, [])

  const onlineHostKey = capableHosts
    .filter((host) => !host.remote || host.state === 'online')
    .map((host) => `${host.id}@${host.epoch}`)
    .join('|')

  const refreshAll = useCallback(async () => {
    const online = hostsRef.current.filter(
      (host) => isRoutineHostCapable(host) && (!host.remote || host.state === 'online')
    )
    const ids = online.length > 0 ? online.map((h) => h.id) : [LOCAL_HOST_ID]
    await Promise.all(ids.map((id) => refreshHost(id)))
  }, [refreshHost])

  // Reads the cache through a ref: depending on it would make every host refresh recreate this, and with it the host
  // subscriptions. The online hosts are a dependency so that a host going offline swaps the detail to its cached runs.
  const refreshDetail = useCallback(async () => {
    if (!detailRoutineId) {
      setDetailRuns([])
      setDetailTotal(0)
      setDetailHasMore(false)
      setSavedPermissions([])
      return
    }
    const { hostId, id, api } = hostTarget(detailRoutineId)
    const host = hostsRef.current.find((h) => h.id === hostId)
    if (host?.remote && host.state !== 'online') {
      // Keep last cached runs from runsByRoutine when viewing an offline host's routine.
      const cached = byHostRef.current[hostId]?.runsByRoutine[id] ?? []
      const keyed = cached.map((run) => shellRoutineRun(hostId, run))
      setDetailRuns(keyed)
      setDetailTotal(keyed.length)
      setDetailHasMore(false)
      setSavedPermissions([])
      return
    }
    try {
      const [runsRes, perms] = await Promise.all([
        api.routinesListRuns({ routineId: id, filter: detailFilter, limit: detailLimit }),
        api.routinesListSavedPermissions(id),
      ])
      setDetailRuns(runsRes.runs.map((run) => shellRoutineRun(hostId, run)))
      setDetailTotal(runsRes.total)
      setDetailHasMore(runsRes.hasMore)
      setSavedPermissions(perms)
    } catch {
      // Ignore if routine was deleted concurrently or host went offline
    }
  }, [detailRoutineId, detailFilter, detailLimit, onlineHostKey])
  const refreshDetailRef = useRef(refreshDetail)
  refreshDetailRef.current = refreshDetail
  const detailRoutineIdRef = useRef(detailRoutineId)
  detailRoutineIdRef.current = detailRoutineId

  useEffect(() => {
    setDetailFilter('all')
    setDetailLimit(10)
  }, [detailRoutineId])

  // Subscribe to each online routine-capable host and refresh it on change or epoch bump. Only the set of online hosts
  // re-subscribes: the detail is read through refs, as a dependency on it would refresh every host on every refresh.
  useEffect(() => {
    const onlineHosts = hostsRef.current.filter(
      (host) => isRoutineHostCapable(host) && (!host.remote || host.state === 'online')
    )
    const ids = onlineHosts.length > 0 ? onlineHosts.map((h) => h.id) : [LOCAL_HOST_ID]
    for (const id of ids) void refreshHost(id)

    const unsubs = ids.map((id) =>
      hostApi(id).onRoutinesChanged?.(() => {
        void refreshHost(id)
        const detailKey = detailRoutineIdRef.current
        if (detailKey && hostOfKey(detailKey) === id) void refreshDetailRef.current()
      })
    )
    const timer = window.setInterval(() => {
      void refreshAll()
    }, 60_000)
    return () => {
      for (const off of unsubs) off?.()
      window.clearInterval(timer)
    }
  }, [onlineHostKey, refreshHost, refreshAll])

  useEffect(() => {
    return () => {
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
    }
  }, [])

  useEffect(() => {
    void refreshDetail()
  }, [refreshDetail])

  const notifySidebarTab = useCallback((tab: string) => {
    sidebarTabRef.current = tab
    if (tab === 'routines') setRailDot(false)
  }, [])

  const clearRailDot = useCallback(() => {
    setRailDot(false)
  }, [])

  const flashRoutine = useCallback((routineId: string) => {
    setFlashRoutineId(routineId)
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setFlashRoutineId(null), 1_700)
  }, [])

  const expandRoutine = useCallback((routineId: string) => {
    setExpandedIds((prev) => {
      if (prev.has(routineId)) return prev
      const next = new Set(prev)
      next.add(routineId)
      return next
    })
  }, [])

  const toggleExpanded = useCallback((routineId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(routineId)) next.delete(routineId)
      else next.add(routineId)
      return next
    })
  }, [])

  const attentionRuns = useMemo(() => {
    const out: { routine: LocalRoutine; run: LocalRoutineRun }[] = []
    for (const routine of routines) {
      for (const run of runsByRoutine[routine.id] ?? []) {
        if (run.status === 'waiting' || (run.status === 'failed' && run.unread)) {
          out.push({ routine, run })
        }
      }
    }
    return out.sort((a, b) => (b.run.startedAt ?? b.run.scheduledAt) - (a.run.startedAt ?? a.run.scheduledAt))
  }, [routines, runsByRoutine])

  const resolveModelInfo = useCallback(
    (model: RoutineModel, hostId: HostId = LOCAL_HOST_ID): RoutineModelDisplayInfo => {
      const cfg = chatConfigByHost[hostId] ?? chatConfigByHost[LOCAL_HOST_ID] ?? null
      const choices = cfg ? chatProviderChoices(cfg) : []
      const provider = choices.find((p) => p.id === model.providerId)
      return {
        name: modelDisplayName(model.modelId),
        providerName: provider?.name ?? model.providerId,
      }
    },
    [chatConfigByHost]
  )

  const startHostEnvironment = useCallback(
    async (hostId: HostId) => {
      const host = hostsRef.current.find((h) => h.id === hostId)
      if (!host?.serverId || !host.environment) return
      setStartingHostIds((prev) => {
        const next = new Set(prev)
        next.add(hostId)
        return next
      })
      try {
        await window.api.fleetEnvironmentAction(host.serverId, host.environment.id, 'start')
      } catch (err) {
        toast({
          id: `routine-host-start-err:${hostId}`,
          tone: 'error',
          icon: 'alert',
          title: t('host.startFailed'),
          description: err instanceof Error ? err.message : undefined,
        })
      } finally {
        setStartingHostIds((prev) => {
          if (!prev.has(hostId)) return prev
          const next = new Set(prev)
          next.delete(hostId)
          return next
        })
      }
    },
    [t]
  )

  const toggleKeepRunning = useCallback(async () => {
    const next = await hostApi(LOCAL_HOST_ID).routinesSetSettings({ keepRunning: !settings.keepRunning })
    setSettings(next)
    if (next.keepRunning) {
      toast({
        id: 'routine-bg-enabled',
        tone: 'ok',
        icon: 'power',
        title: t('background.toastTitle'),
        description: t('background.toastDesc'),
      })
    }
  }, [settings.keepRunning, t])

  const enableKeepRunning = useCallback(async () => {
    if (settings.keepRunning) return
    const next = await hostApi(LOCAL_HOST_ID).routinesSetSettings({ keepRunning: true })
    setSettings(next)
    toast({
      id: 'routine-bg-enabled',
      tone: 'ok',
      icon: 'power',
      title: t('background.toastTitle'),
      description: t('background.toastDesc'),
    })
  }, [settings.keepRunning, t])

  const toggleOpenAtLogin = useCallback(async () => {
    const next = await hostApi(LOCAL_HOST_ID).routinesSetSettings({ openAtLogin: !settings.openAtLogin })
    setSettings(next)
  }, [settings.openAtLogin])

  const toggleRoutineEnabled = useCallback(
    async (routineKey: string) => {
      const current = routines.find((r) => r.id === routineKey)
      if (!current) return
      const { hostId, id, api } = hostTarget(routineKey)
      await api.routinesSetEnabled(id, !current.enabled)
      await refreshHost(hostId)
    },
    [routines, refreshHost]
  )

  const runNow = useCallback(
    async (routineKey: string) => {
      const { hostId, id, api } = hostTarget(routineKey)
      const started = await api.routinesRunNow(id)
      expandRoutine(routineKey)
      await refreshHost(hostId)
      if (detailRoutineId === routineKey) await refreshDetail()
      return started ? shellRoutineRun(hostId, started) : null
    },
    [detailRoutineId, expandRoutine, refreshHost, refreshDetail]
  )

  const stopRun = useCallback(
    async (runKey: string) => {
      const { hostId, id, api } = hostTarget(runKey)
      await api.routinesStopRun(id)
      await refreshHost(hostId)
      await refreshDetail()
    },
    [refreshHost, refreshDetail]
  )

  const pinRun = useCallback(
    async (runKey: string, pinned: boolean) => {
      const { hostId, id, api } = hostTarget(runKey)
      await api.routinesPinRun(id, pinned)
      await refreshHost(hostId)
      await refreshDetail()
    },
    [refreshHost, refreshDetail]
  )

  const deleteRunConversation = useCallback(
    async (runKey: string) => {
      const { hostId, id, api } = hostTarget(runKey)
      const ok = await api.routinesDeleteRunConversation(id)
      await refreshHost(hostId)
      await refreshDetail()
      return ok
    },
    [refreshHost, refreshDetail]
  )

  const duplicateRoutine = useCallback(
    async (routineKey: string) => {
      const { hostId, id, api } = hostTarget(routineKey)
      const copy = await api.routinesDuplicate(id)
      const keyed = shellRoutine(hostId, copy, deviceIdOn)
      await refreshHost(hostId)
      flashRoutine(keyed.id)
      onNavigateRoutine(keyed.id)
      toast({
        id: `routine-dup:${keyed.id}`,
        tone: 'quiet',
        icon: 'copy',
        title: t('toasts.duplicatedTitle'),
        description: t('toasts.duplicatedDesc'),
      })
    },
    [deviceIdOn, refreshHost, flashRoutine, onNavigateRoutine, t]
  )

  const deleteRoutine = useCallback(
    async (routineKey: string) => {
      const { hostId, id, api } = hostTarget(routineKey)
      await api.routinesDelete(id)
      await refreshHost(hostId)
      if (detailRoutineId === routineKey) onNavigateAgenda()
      toast({
        id: `routine-del:${routineKey}`,
        tone: 'quiet',
        icon: 'trash',
        title: t('toasts.deletedTitle'),
      })
    },
    [refreshHost, detailRoutineId, onNavigateAgenda, t]
  )

  const removeSavedPermission = useCallback(
    async (routineKey: string, permId: string) => {
      const target = savedPermissions.find((p) => p.id === permId)
      const { id, api } = hostTarget(routineKey)
      await api.routinesRemoveSavedPermission(id, permId)
      await refreshDetail()
      if (target) {
        toast({
          id: `routine-perm-rm:${permId}`,
          tone: 'quiet',
          icon: 'shield',
          title: t('toasts.permissionRemovedTitle'),
          description: t('toasts.permissionRemovedDesc', { resource: target.resource }),
        })
      }
    },
    [savedPermissions, refreshDetail, t]
  )

  const openFolder = useCallback(
    async (routineKey: string) => {
      const { hostId, id, api } = hostTarget(routineKey)
      const host = hostsRef.current.find((h) => h.id === hostId)
      if (hostId === LOCAL_HOST_ID || host?.desktopEffects) {
        await api.routinesOpenFolder(id)
        return
      }
      const routine = routines.find((r) => r.id === routineKey)
      if (routine && onOpenRemoteFolder) {
        onOpenRemoteFolder({ hostId, folder: routine.folder, title: routine.title })
      }
    },
    [routines, onOpenRemoteFolder]
  )

  const createRoutine = useCallback(
    async ({
      hostId = LOCAL_HOST_ID,
      draft,
      origin = null,
      stayInChat = false,
    }: {
      hostId?: HostId
      draft: RoutineDraft
      /** The origin conversation by its key on this computer (`hostKey`); its own host id is not read. */
      origin?: RoutineOrigin | null
      stayInChat?: boolean
    }) => {
      const normalizedOrigin: RoutineOrigin | null = origin
        ? {
            conversationId: rawId(origin.conversationId),
            title: origin.title,
            via: origin.via,
            ...storedRoutinePlace(hostId, hostOfKey(origin.conversationId), deviceIdOn),
          }
        : null
      const created = await hostApi(hostId).routinesCreate(draft, normalizedOrigin)
      const keyed = shellRoutine(hostId, created, deviceIdOn)
      await refreshHost(hostId)
      flashRoutine(keyed.id)
      const tr = (key: string, opts?: Record<string, unknown>): string => String(t(key as never, opts as never))
      const nextText = keyed.nextRunAt
        ? t('toasts.createdNext', { when: formatWhen(keyed.nextRunAt, Date.now(), tr) })
        : ''
      toast({
        id: `routine-created:${keyed.id}`,
        tone: 'ok',
        icon: 'check',
        title: t('toasts.createdTitle'),
        description: `${keyed.title}${nextText}`,
        action: stayInChat
          ? {
              label: t('toasts.createdAction'),
              onClick: () => onNavigateRoutine(keyed.id),
            }
          : undefined,
      })
      if (!stayInChat) {
        onNavigateRoutine(keyed.id)
      }
      return keyed
    },
    [deviceIdOn, flashRoutine, onNavigateRoutine, refreshHost, t]
  )

  const createFromProposal = useCallback(
    async ({
      proposalHostId = LOCAL_HOST_ID,
      targetHostId = proposalHostId,
      proposalId,
      draft,
      originConversationId,
      originTitle,
    }: {
      proposalHostId?: HostId
      targetHostId?: HostId
      proposalId: string
      draft?: RoutineDraft
      originConversationId?: string
      originTitle?: string
    }) => {
      let created: LocalRoutine
      if (targetHostId === proposalHostId) {
        created = await hostApi(proposalHostId).routinesCreateFromProposal(proposalId, draft)
      } else {
        const proposal = draft ? null : await hostApi(proposalHostId).routinesGetProposal(proposalId)
        const resolvedDraft = draft ?? proposal?.draft
        if (!resolvedDraft) throw new Error(`Routine proposal not found: ${proposalId}`)
        created = await createRoutineFromProposalOnHost({
          proposalHostId,
          targetHostId,
          proposalId,
          draft: resolvedDraft,
          originConversationId: originConversationId ? rawId(originConversationId) : (proposal?.conversationId ?? null),
          originTitle: originTitle ?? '',
          deviceIdOn,
        })
      }

      const keyed = shellRoutine(targetHostId, created, deviceIdOn)
      await refreshHost(targetHostId)
      if (proposalHostId !== targetHostId) await refreshHost(proposalHostId)
      flashRoutine(keyed.id)
      const tr = (key: string, opts?: Record<string, unknown>): string => String(t(key as never, opts as never))
      const nextText = keyed.nextRunAt
        ? t('toasts.createdNext', { when: formatWhen(keyed.nextRunAt, Date.now(), tr) })
        : ''
      toast({
        id: `routine-created:${keyed.id}`,
        tone: 'ok',
        icon: 'check',
        title: t('toasts.createdTitle'),
        description: `${keyed.title}${nextText}`,
        action: {
          label: t('toasts.createdAction'),
          onClick: () => onNavigateRoutine(keyed.id),
        },
      })
      return keyed
    },
    [deviceIdOn, flashRoutine, onNavigateRoutine, refreshHost, t]
  )

  const updateRoutine = useCallback(
    async (routineKey: string, patch: RoutineUpdatePatch) => {
      const { hostId, id, api } = hostTarget(routineKey)
      const updated = await api.routinesUpdate(id, patch)
      await refreshHost(hostId)
      await refreshDetail()
      toast({
        id: `routine-saved:${routineKey}`,
        tone: 'ok',
        icon: 'check',
        title: t('toasts.savedTitle'),
      })
      return shellRoutine(hostId, updated, deviceIdOn)
    },
    [deviceIdOn, refreshHost, refreshDetail, t]
  )

  return {
    routines,
    runsByRoutine,
    timelineRunsByRoutine,
    attentionRuns,
    chatConfigByHost,
    settings,
    preventSleepEnabled,
    expandedIds,
    railDot,
    flashRoutineId,
    startingHostIds,
    detailFilter,
    setDetailFilter,
    detailRuns,
    detailTotal,
    detailHasMore,
    showMoreDetailRuns: () => setDetailLimit((limit) => limit + 10),
    savedPermissions,
    resolveModelInfo,
    refreshAll,
    refreshHost,
    refreshDetail,
    notifySidebarTab,
    clearRailDot,
    flashRoutine,
    expandRoutine,
    toggleExpanded,
    startHostEnvironment,
    toggleKeepRunning,
    enableKeepRunning,
    toggleOpenAtLogin,
    toggleRoutineEnabled,
    runNow,
    stopRun,
    pinRun,
    deleteRunConversation,
    duplicateRoutine,
    deleteRoutine,
    removeSavedPermission,
    openFolder,
    createRoutine,
    createFromProposal,
    updateRoutine,
  }
}

export function useRoutineRunDetails(runKey: string | null): RoutineRunDetails | null {
  const [details, setDetails] = useState<RoutineRunDetails | null>(null)

  useEffect(() => {
    if (!runKey) {
      setDetails(null)
      return
    }
    const { hostId, id, api } = hostTarget(runKey)
    let alive = true
    const load = async () => {
      try {
        const res = await api.routinesGetRun(id)
        if (!alive) return
        setDetails(
          res
            ? {
                run: shellRoutineRun(hostId, res.run),
                conversation: res.conversation ? shellConversation(hostId, res.conversation) : null,
              }
            : null
        )
      } catch {
        if (alive) setDetails(null)
      }
    }
    void load()
    const off = api.onRoutinesChanged?.(() => {
      void load()
    })
    return () => {
      alive = false
      off?.()
    }
  }, [runKey])

  return details
}

export function shouldOpenRoutinesAgendaOnTab(
  tab: string,
  routinesView: { kind: string } | null,
  activeRoutineRunId: string | null
): boolean {
  return tab === 'routines' && routinesView === null && activeRoutineRunId === null
}

export function shouldShowChatsRoutineHint(query: string, routinesCount: number): boolean {
  return query.trim().length === 0 && routinesCount > 0
}

export { hostKey }
