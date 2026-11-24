import { useEffect, useMemo, useState } from 'react'
import { hostApi, useHostApi } from '@/lib/hosts/host-context'
import { type HostId, hostKey, parseHostKey } from '../../shared/host-key'
import type { MaestroSwarmTask } from '../../shared/maestro-swarm'

const EMPTY_TASKS: MaestroSwarmTask[] = []
const EMPTY_PHASES = new Map<string, MaestroSwarmTask>()

/** Fetch and live-update the swarm tasks of a single Maestro orchestrator conversation. */
export function useMaestroSwarm(conversationId: string | null): MaestroSwarmTask[] {
  const api = useHostApi()
  const [state, setState] = useState<{ conversationId: string | null; tasks: MaestroSwarmTask[] }>({
    conversationId: null,
    tasks: EMPTY_TASKS,
  })

  useEffect(() => {
    if (!conversationId) {
      setState((prev) => (prev.conversationId === null && prev.tasks.length === 0 ? prev : { conversationId: null, tasks: EMPTY_TASKS }))
      return
    }

    let cancelled = false
    let seq = 0
    const refresh = () => {
      const requestSeq = ++seq
      void api
        .chatMaestroSwarmGet(conversationId)
        .then((tasks) => {
          if (!cancelled && requestSeq === seq) setState({ conversationId, tasks })
        })
        .catch(() => undefined)
    }

    refresh()
    const off = api.onMaestroSwarmChanged((payload) => {
      if (payload.conversationId === conversationId) refresh()
    })

    return () => {
      cancelled = true
      off()
    }
  }, [api, conversationId])

  return conversationId && state.conversationId === conversationId ? state.tasks : EMPTY_TASKS
}

/**
 * Fetch and live-update swarm tasks for a set of Maestro root conversations, keyed by worker conversationId.
 * Stable when `rootConversationIds` contains the same set of ids across renders.
 */
export function useMaestroSwarmPhases(rootConversationIds: string[]): Map<string, MaestroSwarmTask> {
  const idsKey = (() => {
    const seen = new Set<string>()
    const unique: string[] = []
    for (const id of rootConversationIds) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      unique.push(id)
    }
    unique.sort()
    return unique.join('\0')
  })()

  const stableIds = useMemo(() => (idsKey ? idsKey.split('\0') : []), [idsKey])
  const [phases, setPhases] = useState<Map<string, MaestroSwarmTask>>(EMPTY_PHASES)

  useEffect(() => {
    if (stableIds.length === 0) {
      setPhases((prev) => (prev.size === 0 ? prev : EMPTY_PHASES))
      return
    }

    let cancelled = false
    const byRoot = new Map<string, MaestroSwarmTask[]>()
    const seqByRoot = new Map<string, number>()

    const rebuild = () => {
      const next = new Map<string, MaestroSwarmTask>()
      for (const [shellRootId, tasks] of byRoot) {
        const { hostId } = parseHostKey(shellRootId)
        for (const task of tasks) {
          if (task.conversationId) next.set(hostKey(hostId, task.conversationId), task)
        }
      }
      setPhases(next)
    }

    const fetchRoot = (hostId: HostId, rawRootId: string, shellRootId: string) => {
      const requestSeq = (seqByRoot.get(shellRootId) ?? 0) + 1
      seqByRoot.set(shellRootId, requestSeq)
      void hostApi(hostId)
        .chatMaestroSwarmGet(rawRootId)
        .then((tasks) => {
          if (cancelled || seqByRoot.get(shellRootId) !== requestSeq) return
          byRoot.set(shellRootId, tasks)
          rebuild()
        })
        .catch(() => undefined)
    }

    const byHost = new Map<HostId, Map<string, string>>()
    for (const shellRootId of stableIds) {
      const { hostId, id: rawRootId } = parseHostKey(shellRootId)
      let hostRoots = byHost.get(hostId)
      if (!hostRoots) {
        hostRoots = new Map<string, string>()
        byHost.set(hostId, hostRoots)
      }
      hostRoots.set(rawRootId, shellRootId)
    }

    const unsubscribers: Array<() => void> = []
    for (const [hostId, rawToShell] of byHost) {
      for (const [rawRootId, shellRootId] of rawToShell) {
        fetchRoot(hostId, rawRootId, shellRootId)
      }
      const off = hostApi(hostId).onMaestroSwarmChanged((payload) => {
        const shellRootId = rawToShell.get(payload.conversationId)
        if (shellRootId) fetchRoot(hostId, payload.conversationId, shellRootId)
      })
      unsubscribers.push(off)
    }

    return () => {
      cancelled = true
      for (const off of unsubscribers) off()
    }
  }, [stableIds])

  return phases
}
