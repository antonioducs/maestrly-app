import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { FleetInteractionResolution } from '@maestrly/bot-fleet-protocol'
import { type FleetServerId, type FleetServerView, NO_FLEET_SERVER } from '../../../shared/fleet-servers'
import {
  emptyRuns,
  emptyThreads,
  emptyTranscript,
  type FleetAction,
  type FleetState,
  fleetServersReducer,
  initialFleetState,
  runTranscriptKey,
} from './state'
import { fleetErrorMessage } from './errors'

/** The bot or the environment whose lifecycle action failed. */
type ActionError = { botId: string | null; environmentId: string | null; message: string }

/** What a view does with one server's bots and environments; the same functions for as long as the window lives. */
function createFleetActions(
  serverId: FleetServerId,
  dispatch: (action: FleetAction) => void,
  stateOf: () => FleetState,
  setActionError: (error: ActionError | null) => void
) {
  const loadTranscript = async (botId: string, before?: string | null) => {
    dispatch({ type: 'transcript.loading', botId })
    try {
      const page = await window.api.fleetGetTranscript(serverId, botId, before)
      dispatch({ type: 'transcript.page', botId, page, older: !!before })
    } catch (error) {
      dispatch({ type: 'transcript.error', botId, error: fleetErrorMessage(error) })
      throw error
    }
  }
  /** A page of a bot's routine runs: the newest, or with `before` the ones before it. */
  const loadRuns = async (botId: string, before?: string | null) => {
    dispatch({ type: 'runs.loading', botId })
    try {
      const page = await window.api.fleetListRuns(serverId, botId, before ?? null)
      dispatch({ type: 'runs.page', botId, page, older: !!before })
    } catch (error) {
      dispatch({ type: 'runs.error', botId, error: fleetErrorMessage(error) })
      throw error
    }
  }
  const loadRunTranscript = async (botId: string, runId: string, before?: string | null) => {
    dispatch({ type: 'runTranscript.loading', botId, runId })
    try {
      const page = await window.api.fleetGetRunTranscript(serverId, botId, runId, before)
      dispatch({ type: 'runTranscript.page', botId, runId, page, older: !!before })
    } catch (error) {
      dispatch({ type: 'runTranscript.error', botId, runId, error: fleetErrorMessage(error) })
      throw error
    }
  }
  /** A bot's conversations with other bots (`peer-conversations`). */
  const loadThreads = async (botId: string) => {
    dispatch({ type: 'threads.loading', botId })
    try {
      const { threads } = await window.api.fleetListPeerThreads(serverId, botId)
      dispatch({ type: 'threads.list', botId, threads })
    } catch (error) {
      dispatch({ type: 'threads.error', botId, error: fleetErrorMessage(error) })
      throw error
    }
  }
  /** A thread's transcript, kept beside the runs' by the thread's id. */
  const loadThreadTranscript = async (botId: string, threadId: string, before?: string | null) => {
    dispatch({ type: 'runTranscript.loading', botId, runId: threadId })
    try {
      const page = await window.api.fleetGetPeerThreadTranscript(serverId, botId, threadId, before)
      dispatch({ type: 'runTranscript.page', botId, runId: threadId, page, older: !!before })
    } catch (error) {
      dispatch({ type: 'runTranscript.error', botId, runId: threadId, error: fleetErrorMessage(error) })
      throw error
    }
  }
  const refresh = async () => {
    const snapshot = await window.api.fleetRefresh(serverId)
    dispatch({ type: 'snapshot', value: snapshot })
  }
  const ensureRuns = (botId: string) => {
    const entry = stateOf().runs[botId] ?? emptyRuns
    if (!entry.loaded && !entry.loading) void loadRuns(botId).catch(() => {})
  }
  const ensureRunTranscript = (botId: string, runId: string) => {
    const entry = stateOf().runTranscripts[runTranscriptKey(botId, runId)] ?? emptyTranscript
    if (!entry.loaded && !entry.loading) void loadRunTranscript(botId, runId).catch(() => {})
  }
  const ensureThreads = (botId: string) => {
    const entry = stateOf().threads[botId] ?? emptyThreads
    if (!entry.loaded && !entry.loading) void loadThreads(botId).catch(() => {})
  }
  const ensureThreadTranscript = (botId: string, threadId: string) => {
    const entry = stateOf().runTranscripts[runTranscriptKey(botId, threadId)] ?? emptyTranscript
    if (!entry.loaded && !entry.loading) void loadThreadTranscript(botId, threadId).catch(() => {})
  }
  const ensureTranscript = (botId: string) => {
    const entry = stateOf().transcripts[botId] ?? emptyTranscript
    if (!entry.loaded && !entry.loading) void loadTranscript(botId).catch(() => {})
  }
  const botAction = async (botId: string, action: Parameters<typeof window.api.fleetBotAction>[2]) => {
    setActionError(null)
    try {
      const result = await window.api.fleetBotAction(serverId, botId, action)
      if (result) dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot: result } })
    } catch (error) {
      setActionError({ botId, environmentId: null, message: fleetErrorMessage(error) })
    }
  }
  const environmentAction = async (
    environmentId: string,
    action: Parameters<typeof window.api.fleetEnvironmentAction>[2]
  ) => {
    setActionError(null)
    try {
      const environment = await window.api.fleetEnvironmentAction(serverId, environmentId, action)
      dispatch({ type: 'event', value: { type: 'environment.updated', at: new Date().toISOString(), environment } })
    } catch (error) {
      setActionError({ botId: null, environmentId, message: fleetErrorMessage(error) })
    }
  }
  /** `idle` schedules the environment's update for when its bots are idle; `now` restarts it at once. */
  const updateEnvironment = async (environmentId: string, when: 'idle' | 'now') => {
    setActionError(null)
    try {
      const environment = await window.api.fleetEnvironmentUpdate(serverId, environmentId, when)
      dispatch({ type: 'event', value: { type: 'environment.updated', at: new Date().toISOString(), environment } })
    } catch (error) {
      setActionError({ botId: null, environmentId, message: fleetErrorMessage(error) })
    }
  }
  const cancelEnvironmentUpdate = async (environmentId: string) => {
    setActionError(null)
    try {
      const environment = await window.api.fleetEnvironmentUpdateCancel(serverId, environmentId)
      dispatch({ type: 'event', value: { type: 'environment.updated', at: new Date().toISOString(), environment } })
    } catch (error) {
      setActionError({ botId: null, environmentId, message: fleetErrorMessage(error) })
    }
  }
  /** Asks the environment to check for Claude Code and Codex releases; the answer shows the check started. */
  const checkEnvironmentRuntimes = async (environmentId: string) => {
    setActionError(null)
    try {
      const environment = await window.api.fleetEnvironmentRuntimesCheck(serverId, environmentId)
      dispatch({ type: 'event', value: { type: 'environment.updated', at: new Date().toISOString(), environment } })
    } catch (error) {
      setActionError({ botId: null, environmentId, message: fleetErrorMessage(error) })
    }
  }
  const resolve = async (botId: string, id: string, resolution: FleetInteractionResolution) => {
    await window.api.fleetResolveInteraction(serverId, botId, id, resolution)
    const [bot, inbox] = await Promise.all([
      window.api.fleetGetBot(serverId, botId),
      window.api.fleetGetInbox(serverId),
    ])
    dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot } })
    dispatch({ type: 'event', value: { type: 'inbox.updated', at: new Date().toISOString(), items: inbox.items } })
    if (stateOf().transcripts[botId]?.loaded) await loadTranscript(botId)
  }
  return {
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
  }
}
type FleetActions = ReturnType<typeof createFleetActions>

/** One server's bots and environments, as the views use them. */
export type FleetController = FleetActions & {
  serverId: FleetServerId
  state: FleetState
  actionError: ActionError | null
}

/** The state of every paired server: events of each apply as they arrive, transcripts load as views show them. */
export function useFleets() {
  const [servers, setServers] = useState<FleetServerView[]>([])
  const [states, dispatchAll] = useReducer(fleetServersReducer, {})
  const [actionErrors, setActionErrors] = useState<Record<string, ActionError | null>>({})
  const statesRef = useRef(states)
  statesRef.current = states
  const actions = useRef(new Map<FleetServerId, FleetActions>())
  const actionsFor = useCallback((serverId: FleetServerId): FleetActions => {
    let found = actions.current.get(serverId)
    if (!found) {
      found = createFleetActions(
        serverId,
        (action) => dispatchAll({ serverId, action }),
        () => statesRef.current[serverId] ?? initialFleetState,
        (error) => setActionErrors((all) => ({ ...all, [serverId]: error }))
      )
      actions.current.set(serverId, found)
    }
    return found
  }, [])

  useEffect(() => {
    let active = true
    const known = new Set<FleetServerId>()
    const loadSnapshot = (serverId: FleetServerId) =>
      void window.api
        .fleetGetSnapshot(serverId)
        .then((snapshot) => {
          if (active) dispatchAll({ serverId, action: { type: 'snapshot', value: snapshot } })
        })
        .catch(() => {})
    const follow = (list: FleetServerView[]) => {
      setServers(list)
      dispatchAll({ type: 'retain', ids: list.map((server) => server.id) })
      for (const server of list) {
        dispatchAll({ serverId: server.id, action: { type: 'connection', value: server.connection } })
        if (!known.has(server.id)) loadSnapshot(server.id)
      }
      known.clear()
      for (const server of list) known.add(server.id)
    }
    void window.api
      .fleetServers()
      .then((list) => {
        if (active) follow(list)
      })
      .catch(() => {})
    const offServers = window.api.onFleetServers((list) => follow(list))
    const offConnection = window.api.onFleetConnection((serverId, connection) => {
      dispatchAll({ serverId, action: { type: 'connection', value: connection } })
      if (connection.state === 'connected') loadSnapshot(serverId)
    })
    const offEvent = window.api.onFleetEvent((serverId, event) => {
      const before = statesRef.current[serverId] ?? initialFleetState
      const fleet = actionsFor(serverId)
      dispatchAll({ serverId, action: { type: 'event', value: event } })
      if (event.type === 'transcript.reset' && before.transcripts[event.botId]?.loaded) {
        void fleet.loadTranscript(event.botId).catch(() => {})
        // The bot restarted or its stream broke: what its runs and threads did meanwhile is read again too.
        if (before.runs[event.botId]?.loaded) void fleet.loadRuns(event.botId).catch(() => {})
        if (before.threads[event.botId]?.loaded) void fleet.loadThreads(event.botId).catch(() => {})
        const threadIds = new Set((before.threads[event.botId]?.threads ?? []).map((thread) => thread.id))
        for (const key of Object.keys(before.runTranscripts))
          if (key.startsWith(runTranscriptKey(event.botId, '')) && before.runTranscripts[key].loaded) {
            const id = key.slice(runTranscriptKey(event.botId, '').length)
            void (
              threadIds.has(id) ? fleet.loadThreadTranscript(event.botId, id) : fleet.loadRunTranscript(event.botId, id)
            ).catch(() => {})
          }
      }
      if (
        event.type === 'routine_run.transcript.reset' &&
        before.runTranscripts[runTranscriptKey(event.botId, event.runId)]?.loaded
      )
        void fleet.loadRunTranscript(event.botId, event.runId).catch(() => {})
      if (
        event.type === 'peer_thread.transcript.reset' &&
        before.runTranscripts[runTranscriptKey(event.botId, event.threadId)]?.loaded
      )
        void fleet.loadThreadTranscript(event.botId, event.threadId).catch(() => {})
    })
    return () => {
      active = false
      offServers()
      offConnection()
      offEvent()
    }
  }, [actionsFor])

  /** One server's controller; a server that is not paired (or no server) is unconfigured. */
  const controller = (serverId: FleetServerId): FleetController => ({
    ...actionsFor(serverId),
    serverId,
    state: (serverId === NO_FLEET_SERVER ? undefined : states[serverId]) ?? initialFleetState,
    actionError: actionErrors[serverId] ?? null,
  })
  return { servers, controller }
}
export type FleetServers = ReturnType<typeof useFleets>
