import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { FleetInteractionResolution } from '@maestrly/bot-fleet-protocol'
import { emptyRuns, emptyThreads, emptyTranscript, fleetReducer, initialFleetState, runTranscriptKey } from './state'
import { fleetErrorMessage } from './errors'

export function useFleet() {
  const [state, dispatch] = useReducer(fleetReducer, initialFleetState)
  // The bot or the environment whose lifecycle action failed.
  const [actionError, setActionError] = useState<{
    botId: string | null
    environmentId: string | null
    message: string
  } | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const loadTranscript = useCallback(async (botId: string, before?: string | null) => {
    dispatch({ type: 'transcript.loading', botId })
    try {
      const page = await window.api.fleetGetTranscript(botId, before)
      dispatch({ type: 'transcript.page', botId, page, older: !!before })
    } catch (error) {
      dispatch({ type: 'transcript.error', botId, error: fleetErrorMessage(error) })
      throw error
    }
  }, [])
  /** A page of a bot's routine runs: the newest, or with `before` the ones before it. */
  const loadRuns = useCallback(async (botId: string, before?: string | null) => {
    dispatch({ type: 'runs.loading', botId })
    try {
      const page = await window.api.fleetListRuns(botId, before ?? null)
      dispatch({ type: 'runs.page', botId, page, older: !!before })
    } catch (error) {
      dispatch({ type: 'runs.error', botId, error: fleetErrorMessage(error) })
      throw error
    }
  }, [])
  const loadRunTranscript = useCallback(async (botId: string, runId: string, before?: string | null) => {
    dispatch({ type: 'runTranscript.loading', botId, runId })
    try {
      const page = await window.api.fleetGetRunTranscript(botId, runId, before)
      dispatch({ type: 'runTranscript.page', botId, runId, page, older: !!before })
    } catch (error) {
      dispatch({ type: 'runTranscript.error', botId, runId, error: fleetErrorMessage(error) })
      throw error
    }
  }, [])
  /** A bot's conversations with other bots (`peer-conversations`). */
  const loadThreads = useCallback(async (botId: string) => {
    dispatch({ type: 'threads.loading', botId })
    try {
      const { threads } = await window.api.fleetListPeerThreads(botId)
      dispatch({ type: 'threads.list', botId, threads })
    } catch (error) {
      dispatch({ type: 'threads.error', botId, error: fleetErrorMessage(error) })
      throw error
    }
  }, [])
  /** A thread's transcript, kept beside the runs' by the thread's id. */
  const loadThreadTranscript = useCallback(async (botId: string, threadId: string, before?: string | null) => {
    dispatch({ type: 'runTranscript.loading', botId, runId: threadId })
    try {
      const page = await window.api.fleetGetPeerThreadTranscript(botId, threadId, before)
      dispatch({ type: 'runTranscript.page', botId, runId: threadId, page, older: !!before })
    } catch (error) {
      dispatch({ type: 'runTranscript.error', botId, runId: threadId, error: fleetErrorMessage(error) })
      throw error
    }
  }, [])
  const refresh = useCallback(async () => {
    const snapshot = await window.api.fleetRefresh()
    dispatch({ type: 'snapshot', value: snapshot })
  }, [])
  useEffect(() => {
    let active = true
    void window.api
      .fleetGetConnection()
      .then((connection) => {
        if (active) dispatch({ type: 'connection', value: connection })
      })
      .catch(() => {})
    void window.api
      .fleetGetSnapshot()
      .then((snapshot) => {
        if (active) dispatch({ type: 'snapshot', value: snapshot })
      })
      .catch(() => {})
    const offConnection = window.api.onFleetConnection((connection) => {
      dispatch({ type: 'connection', value: connection })
      if (connection.state === 'connected')
        void window.api
          .fleetGetSnapshot()
          .then((snapshot) => dispatch({ type: 'snapshot', value: snapshot }))
          .catch(() => {})
    })
    const offEvent = window.api.onFleetEvent((event) => {
      const before = stateRef.current
      dispatch({ type: 'event', value: event })
      if (event.type === 'transcript.reset' && before.transcripts[event.botId]?.loaded) {
        void loadTranscript(event.botId).catch(() => {})
        // The bot restarted or its stream broke: what its runs and threads did meanwhile is read again too.
        if (before.runs[event.botId]?.loaded) void loadRuns(event.botId).catch(() => {})
        if (before.threads[event.botId]?.loaded) void loadThreads(event.botId).catch(() => {})
        const threadIds = new Set((before.threads[event.botId]?.threads ?? []).map((thread) => thread.id))
        for (const key of Object.keys(before.runTranscripts))
          if (key.startsWith(runTranscriptKey(event.botId, '')) && before.runTranscripts[key].loaded) {
            const id = key.slice(runTranscriptKey(event.botId, '').length)
            void (threadIds.has(id) ? loadThreadTranscript(event.botId, id) : loadRunTranscript(event.botId, id)).catch(
              () => {}
            )
          }
      }
      if (
        event.type === 'routine_run.transcript.reset' &&
        before.runTranscripts[runTranscriptKey(event.botId, event.runId)]?.loaded
      )
        void loadRunTranscript(event.botId, event.runId).catch(() => {})
      if (
        event.type === 'peer_thread.transcript.reset' &&
        before.runTranscripts[runTranscriptKey(event.botId, event.threadId)]?.loaded
      )
        void loadThreadTranscript(event.botId, event.threadId).catch(() => {})
    })
    return () => {
      active = false
      offConnection()
      offEvent()
    }
  }, [loadRuns, loadRunTranscript, loadThreads, loadThreadTranscript, loadTranscript])
  const ensureRuns = useCallback(
    (botId: string) => {
      const entry = stateRef.current.runs[botId] ?? emptyRuns
      if (!entry.loaded && !entry.loading) void loadRuns(botId).catch(() => {})
    },
    [loadRuns]
  )
  const ensureRunTranscript = useCallback(
    (botId: string, runId: string) => {
      const entry = stateRef.current.runTranscripts[runTranscriptKey(botId, runId)] ?? emptyTranscript
      if (!entry.loaded && !entry.loading) void loadRunTranscript(botId, runId).catch(() => {})
    },
    [loadRunTranscript]
  )
  const ensureThreads = useCallback(
    (botId: string) => {
      const entry = stateRef.current.threads[botId] ?? emptyThreads
      if (!entry.loaded && !entry.loading) void loadThreads(botId).catch(() => {})
    },
    [loadThreads]
  )
  const ensureThreadTranscript = useCallback(
    (botId: string, threadId: string) => {
      const entry = stateRef.current.runTranscripts[runTranscriptKey(botId, threadId)] ?? emptyTranscript
      if (!entry.loaded && !entry.loading) void loadThreadTranscript(botId, threadId).catch(() => {})
    },
    [loadThreadTranscript]
  )
  const ensureTranscript = useCallback(
    (botId: string) => {
      const entry = stateRef.current.transcripts[botId] ?? emptyTranscript
      if (!entry.loaded && !entry.loading) void loadTranscript(botId).catch(() => {})
    },
    [loadTranscript]
  )
  const botAction = useCallback(async (botId: string, action: Parameters<typeof window.api.fleetBotAction>[1]) => {
    setActionError(null)
    try {
      const result = await window.api.fleetBotAction(botId, action)
      if (result) dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot: result } })
    } catch (error) {
      setActionError({ botId, environmentId: null, message: fleetErrorMessage(error) })
    }
  }, [])
  const environmentAction = useCallback(
    async (environmentId: string, action: Parameters<typeof window.api.fleetEnvironmentAction>[1]) => {
      setActionError(null)
      try {
        const environment = await window.api.fleetEnvironmentAction(environmentId, action)
        dispatch({ type: 'event', value: { type: 'environment.updated', at: new Date().toISOString(), environment } })
      } catch (error) {
        setActionError({ botId: null, environmentId, message: fleetErrorMessage(error) })
      }
    },
    []
  )
  /** `idle` schedules the environment's update for when its bots are idle; `now` restarts it at once. */
  const updateEnvironment = useCallback(async (environmentId: string, when: 'idle' | 'now') => {
    setActionError(null)
    try {
      const environment = await window.api.fleetEnvironmentUpdate(environmentId, when)
      dispatch({ type: 'event', value: { type: 'environment.updated', at: new Date().toISOString(), environment } })
    } catch (error) {
      setActionError({ botId: null, environmentId, message: fleetErrorMessage(error) })
    }
  }, [])
  const cancelEnvironmentUpdate = useCallback(async (environmentId: string) => {
    setActionError(null)
    try {
      const environment = await window.api.fleetEnvironmentUpdateCancel(environmentId)
      dispatch({ type: 'event', value: { type: 'environment.updated', at: new Date().toISOString(), environment } })
    } catch (error) {
      setActionError({ botId: null, environmentId, message: fleetErrorMessage(error) })
    }
  }, [])
  /** Asks the environment to check for Claude Code and Codex releases; the answer shows the check started. */
  const checkEnvironmentRuntimes = useCallback(async (environmentId: string) => {
    setActionError(null)
    try {
      const environment = await window.api.fleetEnvironmentRuntimesCheck(environmentId)
      dispatch({ type: 'event', value: { type: 'environment.updated', at: new Date().toISOString(), environment } })
    } catch (error) {
      setActionError({ botId: null, environmentId, message: fleetErrorMessage(error) })
    }
  }, [])
  const resolve = useCallback(
    async (botId: string, id: string, resolution: FleetInteractionResolution) => {
      await window.api.fleetResolveInteraction(botId, id, resolution)
      const [bot, inbox] = await Promise.all([window.api.fleetGetBot(botId), window.api.fleetGetInbox()])
      dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot } })
      dispatch({ type: 'event', value: { type: 'inbox.updated', at: new Date().toISOString(), items: inbox.items } })
      if (stateRef.current.transcripts[botId]?.loaded) await loadTranscript(botId)
    },
    [loadTranscript]
  )
  return {
    state,
    dispatch,
    refresh,
    loadTranscript,
    ensureTranscript,
    loadRuns,
    ensureRuns,
    loadRunTranscript,
    ensureRunTranscript,
    loadThreads,
    ensureThreads,
    loadThreadTranscript,
    ensureThreadTranscript,
    botAction,
    environmentAction,
    updateEnvironment,
    cancelEnvironmentUpdate,
    checkEnvironmentRuntimes,
    resolve,
    actionError,
  }
}
export type FleetController = ReturnType<typeof useFleet>
