import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatConfig } from '../../../shared/chat'
import { LOCAL_HOST_ID } from '../../../shared/host-key'
import {
  DEFAULT_ROUTINE_SETTINGS,
  type LocalRoutine,
  type LocalRoutineRun,
  type RoutineModel,
  type RoutineRunDetails,
  type RoutineRunFilter,
  type RoutineSavedPermission,
  type RoutineSettings,
} from '../../../shared/routines'
import { hostApi } from '@/lib/hosts/host-context'
import { chatProviderChoices } from '@/components/chat/account-pool'
import { modelDisplayName } from '@/components/chat/model-search'
import { toast } from '@/components/ui/toaster'
import type { RoutineDraft, RoutineOrigin, RoutineUpdatePatch } from '../../../shared/routines'
import { addLocalDays, formatWhen, startOfLocalDay } from './relative-time'

export interface RoutineModelDisplayInfo {
  name: string
  providerName: string
}

export function useRoutines({
  detailRoutineId,
  onNavigateAgenda,
  onNavigateRoutine,
}: {
  detailRoutineId: string | null
  onNavigateAgenda: () => void
  onNavigateRoutine: (routineId: string) => void
}) {
  const { t } = useTranslation('routines')
  const [routines, setRoutines] = useState<LocalRoutine[]>([])
  const [runsByRoutine, setRunsByRoutine] = useState<Record<string, LocalRoutineRun[]>>({})
  const [timelineRunsByRoutine, setTimelineRunsByRoutine] = useState<Record<string, LocalRoutineRun[]>>({})
  const [settings, setSettings] = useState<RoutineSettings>(DEFAULT_ROUTINE_SETTINGS)
  const [preventSleepEnabled, setPreventSleepEnabled] = useState(true)
  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [railDot, setRailDot] = useState(false)
  const [flashRoutineId, setFlashRoutineId] = useState<string | null>(null)

  const [detailFilter, setDetailFilter] = useState<RoutineRunFilter>('all')
  const [detailLimit, setDetailLimit] = useState(10)
  const [detailRuns, setDetailRuns] = useState<LocalRoutineRun[]>([])
  const [detailTotal, setDetailTotal] = useState(0)
  const [detailHasMore, setDetailHasMore] = useState(false)
  const [savedPermissions, setSavedPermissions] = useState<RoutineSavedPermission[]>([])

  const knownRoutineIdsRef = useRef<Set<string> | null>(null)
  const sidebarTabRef = useRef<string>('workspaces')
  const flashTimerRef = useRef<number | null>(null)

  const refreshAll = useCallback(async () => {
    try {
      const localApi = hostApi(LOCAL_HOST_ID)
      const [list, nextSettings, keepAwake, cfg] = await Promise.all([
        window.api.routinesList(),
        window.api.routinesGetSettings(),
        localApi.getPreventSleepEnabled().catch(() => true),
        localApi.chatConfig().catch(() => null),
      ])
      setRoutines(list)
      setSettings(nextSettings)
      setPreventSleepEnabled(keepAwake)
      if (cfg) setChatConfig(cfg)

      if (knownRoutineIdsRef.current !== null) {
        const added = list.find((item) => !knownRoutineIdsRef.current!.has(item.id))
        if (added && sidebarTabRef.current !== 'routines') {
          setRailDot(true)
        }
      }
      knownRoutineIdsRef.current = new Set(list.map((item) => item.id))

      const now = Date.now()
      const from = addLocalDays(startOfLocalDay(now), -2)
      const to = addLocalDays(from, 7)

      const [rangeRuns, perRoutineRuns] = await Promise.all([
        window.api.routinesRunsInRange(from, to),
        Promise.all(
          list.map(async (routine) => {
            const res = await window.api.routinesListRuns({ routineId: routine.id, filter: 'all', limit: 20 })
            return [routine.id, res.runs] as const
          })
        ),
      ])

      const byRoutine: Record<string, LocalRoutineRun[]> = {}
      for (const [id, runs] of perRoutineRuns) byRoutine[id] = runs
      setRunsByRoutine(byRoutine)

      const tlByRoutine: Record<string, LocalRoutineRun[]> = {}
      for (const run of rangeRuns) {
        ;(tlByRoutine[run.routineId] ??= []).push(run)
      }
      setTimelineRunsByRoutine(tlByRoutine)
    } catch {
      // Ignore transient startup/reload errors
    }
  }, [])

  const refreshDetail = useCallback(async () => {
    if (!detailRoutineId) {
      setDetailRuns([])
      setDetailTotal(0)
      setDetailHasMore(false)
      setSavedPermissions([])
      return
    }
    try {
      const [runsRes, perms] = await Promise.all([
        window.api.routinesListRuns({ routineId: detailRoutineId, filter: detailFilter, limit: detailLimit }),
        window.api.routinesListSavedPermissions(detailRoutineId),
      ])
      setDetailRuns(runsRes.runs)
      setDetailTotal(runsRes.total)
      setDetailHasMore(runsRes.hasMore)
      setSavedPermissions(perms)
    } catch {
      // Ignore if routine was deleted concurrently
    }
  }, [detailRoutineId, detailFilter, detailLimit])

  useEffect(() => {
    setDetailFilter('all')
    setDetailLimit(10)
  }, [detailRoutineId])

  useEffect(() => {
    void refreshAll()
    const offRoutines = window.api.onRoutinesChanged?.(() => {
      void refreshAll()
      void refreshDetail()
    })
    const timer = window.setInterval(() => {
      void refreshAll()
    }, 60_000)
    return () => {
      offRoutines?.()
      window.clearInterval(timer)
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
    }
  }, [refreshAll, refreshDetail])

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
    (model: RoutineModel): RoutineModelDisplayInfo => {
      const choices = chatConfig ? chatProviderChoices(chatConfig) : []
      const provider = choices.find((p) => p.id === model.providerId)
      return {
        name: modelDisplayName(model.modelId),
        providerName: provider?.name ?? model.providerId,
      }
    },
    [chatConfig]
  )

  const toggleKeepRunning = useCallback(async () => {
    const next = await window.api.routinesSetSettings({ keepRunning: !settings.keepRunning })
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
    const next = await window.api.routinesSetSettings({ keepRunning: true })
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
    const next = await window.api.routinesSetSettings({ openAtLogin: !settings.openAtLogin })
    setSettings(next)
  }, [settings.openAtLogin])

  const toggleRoutineEnabled = useCallback(
    async (routineId: string) => {
      const current = routines.find((r) => r.id === routineId)
      if (!current) return
      await window.api.routinesSetEnabled(routineId, !current.enabled)
      await refreshAll()
    },
    [routines, refreshAll]
  )

  const runNow = useCallback(
    async (routineId: string) => {
      await window.api.routinesRunNow(routineId)
      expandRoutine(routineId)
      await refreshAll()
      await refreshDetail()
    },
    [expandRoutine, refreshAll, refreshDetail]
  )

  const stopRun = useCallback(
    async (runId: string) => {
      await window.api.routinesStopRun(runId)
      await refreshAll()
      await refreshDetail()
    },
    [refreshAll, refreshDetail]
  )

  const pinRun = useCallback(
    async (runId: string, pinned: boolean) => {
      await window.api.routinesPinRun(runId, pinned)
      await refreshAll()
      await refreshDetail()
    },
    [refreshAll, refreshDetail]
  )

  const deleteRunConversation = useCallback(
    async (runId: string) => {
      const ok = await window.api.routinesDeleteRunConversation(runId)
      await refreshAll()
      await refreshDetail()
      return ok
    },
    [refreshAll, refreshDetail]
  )

  const duplicateRoutine = useCallback(
    async (routineId: string) => {
      const copy = await window.api.routinesDuplicate(routineId)
      await refreshAll()
      flashRoutine(copy.id)
      onNavigateRoutine(copy.id)
      toast({
        id: `routine-dup:${copy.id}`,
        tone: 'quiet',
        icon: 'copy',
        title: t('toasts.duplicatedTitle'),
        description: t('toasts.duplicatedDesc'),
      })
    },
    [refreshAll, flashRoutine, onNavigateRoutine, t]
  )

  const deleteRoutine = useCallback(
    async (routineId: string) => {
      await window.api.routinesDelete(routineId)
      await refreshAll()
      if (detailRoutineId === routineId) onNavigateAgenda()
      toast({
        id: `routine-del:${routineId}`,
        tone: 'quiet',
        icon: 'trash',
        title: t('toasts.deletedTitle'),
      })
    },
    [refreshAll, detailRoutineId, onNavigateAgenda, t]
  )

  const removeSavedPermission = useCallback(
    async (routineId: string, permId: string) => {
      const target = savedPermissions.find((p) => p.id === permId)
      await window.api.routinesRemoveSavedPermission(routineId, permId)
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

  const openFolder = useCallback(async (routineId: string) => {
    await window.api.routinesOpenFolder(routineId)
  }, [])

  const createRoutine = useCallback(
    async ({
      draft,
      origin = null,
      stayInChat = false,
    }: {
      draft: RoutineDraft
      origin?: RoutineOrigin | null
      stayInChat?: boolean
    }) => {
      const created = await window.api.routinesCreate(draft, origin)
      await refreshAll()
      flashRoutine(created.id)
      const tr = (key: string, opts?: Record<string, unknown>): string => String(t(key as never, opts as never))
      const nextText = created.nextRunAt
        ? t('toasts.createdNext', { when: formatWhen(created.nextRunAt, Date.now(), tr) })
        : ''
      toast({
        id: `routine-created:${created.id}`,
        tone: 'ok',
        icon: 'check',
        title: t('toasts.createdTitle'),
        description: `${created.title}${nextText}`,
        action: stayInChat
          ? {
              label: t('toasts.createdAction'),
              onClick: () => onNavigateRoutine(created.id),
            }
          : undefined,
      })
      if (!stayInChat) {
        onNavigateRoutine(created.id)
      }
      return created
    },
    [flashRoutine, onNavigateRoutine, refreshAll, t]
  )

  const createFromProposal = useCallback(
    async (proposalId: string, draft?: RoutineDraft) => {
      const created = await window.api.routinesCreateFromProposal(proposalId, draft)
      await refreshAll()
      flashRoutine(created.id)
      const tr = (key: string, opts?: Record<string, unknown>): string => String(t(key as never, opts as never))
      const nextText = created.nextRunAt
        ? t('toasts.createdNext', { when: formatWhen(created.nextRunAt, Date.now(), tr) })
        : ''
      toast({
        id: `routine-created:${created.id}`,
        tone: 'ok',
        icon: 'check',
        title: t('toasts.createdTitle'),
        description: `${created.title}${nextText}`,
        action: {
          label: t('toasts.createdAction'),
          onClick: () => onNavigateRoutine(created.id),
        },
      })
      return created
    },
    [flashRoutine, onNavigateRoutine, refreshAll, t]
  )

  const updateRoutine = useCallback(
    async (routineId: string, patch: RoutineUpdatePatch) => {
      const updated = await window.api.routinesUpdate(routineId, patch)
      await refreshAll()
      await refreshDetail()
      toast({
        id: `routine-saved:${routineId}`,
        tone: 'ok',
        icon: 'check',
        title: t('toasts.savedTitle'),
      })
      return updated
    },
    [refreshAll, refreshDetail, t]
  )

  return {
    routines,
    runsByRoutine,
    timelineRunsByRoutine,
    attentionRuns,
    settings,
    preventSleepEnabled,
    expandedIds,
    railDot,
    flashRoutineId,
    detailFilter,
    setDetailFilter,
    detailRuns,
    detailTotal,
    detailHasMore,
    showMoreDetailRuns: () => setDetailLimit((limit) => limit + 10),
    savedPermissions,
    resolveModelInfo,
    refreshAll,
    refreshDetail,
    notifySidebarTab,
    clearRailDot,
    flashRoutine,
    expandRoutine,
    toggleExpanded,
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

export function useRoutineRunDetails(runId: string | null): RoutineRunDetails | null {
  const [details, setDetails] = useState<RoutineRunDetails | null>(null)

  useEffect(() => {
    if (!runId) {
      setDetails(null)
      return
    }
    let alive = true
    const load = async () => {
      try {
        const res = await window.api.routinesGetRun(runId)
        if (alive) setDetails(res)
      } catch {
        if (alive) setDetails(null)
      }
    }
    void load()
    const off = window.api.onRoutinesChanged?.(() => {
      void load()
    })
    return () => {
      alive = false
      off?.()
    }
  }, [runId])

  return details
}
