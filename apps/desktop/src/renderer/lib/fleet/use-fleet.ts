import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { FleetInteractionResolution } from '@maestrly/bot-fleet-protocol'
import {
  type FleetConnectionState,
  type FleetConnectionView,
  type FleetServerId,
  type FleetServerView,
  NO_FLEET_SERVER,
} from '../../../shared/fleet-servers'
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

/** A list this window holds, or one on its way: its answer may be from before what changed. */
const held = (entry?: { loaded: boolean; loading: boolean }) => !!entry && (entry.loaded || entry.loading)

/** The bot or the environment whose lifecycle action failed. */
type ActionError = { botId: string | null; environmentId: string | null; message: string }

/** What a view does with one server's bots and environments; the same functions for as long as the window lives. */
export function createFleetActions(
  serverId: FleetServerId,
  dispatch: (action: FleetAction) => void,
  stateOf: () => FleetState,
  setActionError: (error: ActionError | null) => void
) {
  // The newest request for each list. A reload (or a reset, which reloads) overtakes the requests before it: their
  // answers, read earlier, would put back what it replaced. An older page belongs to the newest reload it followed.
  const requests = new Map<string, number>()
  const request = (key: string, newest: boolean) => {
    const id = (requests.get(key) ?? 0) + (newest ? 1 : 0)
    requests.set(key, id)
    return () => requests.get(key) === id
  }
  const loadTranscript = async (botId: string, before?: string | null) => {
    const current = request(`transcript\u0000${botId}`, !before)
    dispatch({ type: 'transcript.loading', botId })
    try {
      const page = await window.api.fleetGetTranscript(serverId, botId, before)
      if (current()) dispatch({ type: 'transcript.page', botId, page, older: !!before })
    } catch (error) {
      if (!current()) return
      dispatch({ type: 'transcript.error', botId, error: fleetErrorMessage(error) })
      throw error
    }
  }
  /** A page of a bot's routine runs: the newest, or with `before` the ones before it. */
  const loadRuns = async (botId: string, before?: string | null) => {
    const current = request(`runs\u0000${botId}`, !before)
    dispatch({ type: 'runs.loading', botId })
    try {
      const page = await window.api.fleetListRuns(serverId, botId, before ?? null)
      if (current()) dispatch({ type: 'runs.page', botId, page, older: !!before })
    } catch (error) {
      if (!current()) return
      dispatch({ type: 'runs.error', botId, error: fleetErrorMessage(error) })
      throw error
    }
  }
  const loadRunTranscript = async (botId: string, runId: string, before?: string | null) => {
    const current = request(`run\u0000${runTranscriptKey(botId, runId)}`, !before)
    dispatch({ type: 'runTranscript.loading', botId, runId })
    try {
      const page = await window.api.fleetGetRunTranscript(serverId, botId, runId, before)
      if (current()) dispatch({ type: 'runTranscript.page', botId, runId, page, older: !!before })
    } catch (error) {
      if (!current()) return
      dispatch({ type: 'runTranscript.error', botId, runId, error: fleetErrorMessage(error) })
      throw error
    }
  }
  /** A bot's conversations with other bots (`peer-conversations`). */
  const loadThreads = async (botId: string) => {
    const current = request(`threads\u0000${botId}`, true)
    dispatch({ type: 'threads.loading', botId })
    try {
      const { threads } = await window.api.fleetListPeerThreads(serverId, botId)
      if (current()) dispatch({ type: 'threads.list', botId, threads })
    } catch (error) {
      if (!current()) return
      dispatch({ type: 'threads.error', botId, error: fleetErrorMessage(error) })
      throw error
    }
  }
  /** A thread's transcript, kept beside the runs' by the thread's id. */
  const loadThreadTranscript = async (botId: string, threadId: string, before?: string | null) => {
    const current = request(`run\u0000${runTranscriptKey(botId, threadId)}`, !before)
    dispatch({ type: 'runTranscript.loading', botId, runId: threadId })
    try {
      const page = await window.api.fleetGetPeerThreadTranscript(serverId, botId, threadId, before)
      if (current()) dispatch({ type: 'runTranscript.page', botId, runId: threadId, page, older: !!before })
    } catch (error) {
      if (!current()) return
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
  /**
   * A bot's conversation as it opens. One shown before is read again too, behind what it shows: its events are the
   * only other way it learns what changed, and the ones sent while this computer could not hear them are lost.
   */
  const ensureTranscript = (botId: string) => {
    const entry = stateOf().transcripts[botId] ?? emptyTranscript
    if (!entry.loading) void loadTranscript(botId).catch(() => {})
  }
  /**
   * Reads again what this window holds of a bot: its conversation, runs and threads, and the transcripts of those
   * opened, as `state` says it holds them.
   */
  const resyncBot = (botId: string, state: FleetState = stateOf()) => {
    if (held(state.transcripts[botId])) void loadTranscript(botId).catch(() => {})
    if (held(state.runs[botId])) void loadRuns(botId).catch(() => {})
    if (held(state.threads[botId])) void loadThreads(botId).catch(() => {})
    const prefix = runTranscriptKey(botId, '')
    const threadIds = new Set((state.threads[botId]?.threads ?? []).map((thread) => thread.id))
    for (const [key, entry] of Object.entries(state.runTranscripts))
      if (key.startsWith(prefix) && held(entry)) {
        const id = key.slice(prefix.length)
        void (threadIds.has(id) ? loadThreadTranscript(botId, id) : loadRunTranscript(botId, id)).catch(() => {})
      }
  }
  /** Every bot whose conversation, runs or threads this window holds. */
  const resyncAll = (state: FleetState = stateOf()) => {
    const bots = new Set([
      ...Object.keys(state.transcripts),
      ...Object.keys(state.runs),
      ...Object.keys(state.threads),
      ...Object.keys(state.runTranscripts).map((key) => key.slice(0, key.indexOf('\u0000'))),
    ])
    for (const botId of bots) resyncBot(botId, state)
  }
  // The server's stream as last told, apart from the renders: several changes can arrive before one.
  let stream: FleetConnectionState | null = null
  /**
   * The server's stream changed. It sends no events again once it reopens, so whatever changed while it was closed
   * is read again; its connection telling something else (its features, its host's name) changes nothing.
   */
  const streamChanged = (state: FleetConnectionState) => {
    const was = stream
    stream = state
    if (state === 'connected' && was !== null && was !== 'connected') resyncAll()
  }
  // What the owner saw, on its way to the gateway (`owner-seen`): each run, or thread activity, is told once at a time.
  const seeing = new Set<string>()
  /**
   * The owner opened a run: it shows as seen at once, and the gateway tells all their devices. Only `seenAt` is taken
   * from the answer: the run's events, which may have overtaken it, say the rest.
   */
  const seeRun = (botId: string, runId: string) => {
    const key = runTranscriptKey(botId, runId)
    const run = () => stateOf().runs[botId]?.runs.find((item) => item.id === runId)
    const shown = run()
    if ((shown && shown.seenAt !== null) || seeing.has(key)) return
    seeing.add(key)
    if (shown) dispatch({ type: 'runs.upsert', botId, run: { ...shown, seenAt: new Date().toISOString() } })
    void window.api
      .fleetSeeRun(serverId, botId, runId)
      .then((updated) => {
        // The gateway's time is the one every device shows; it never changes once set.
        const current = run()
        if (current && current.seenAt !== updated.seenAt)
          dispatch({ type: 'runs.upsert', botId, run: { ...current, seenAt: updated.seenAt } })
      })
      .catch(() => {})
      .finally(() => seeing.delete(key))
  }
  /** The owner saw a thread as it is now: later activity is new, on all their devices. */
  const seeThread = (botId: string, threadId: string) => {
    const thread = () => stateOf().threads[botId]?.threads.find((item) => item.id === threadId)
    const shown = thread()
    if (!shown || shown.seenActivityAt === shown.lastActivityAt) return
    const key = `${runTranscriptKey(botId, threadId)}\u0000${shown.lastActivityAt}`
    if (seeing.has(key)) return
    seeing.add(key)
    dispatch({ type: 'threads.upsert', botId, thread: { ...shown, seenActivityAt: shown.lastActivityAt } })
    void window.api
      .fleetPatchPeerThread(serverId, botId, threadId, { seen: true })
      .then((updated) => {
        const current = thread()
        if (current && current.lastActivityAt === updated.lastActivityAt)
          dispatch({ type: 'threads.upsert', botId, thread: { ...current, seenActivityAt: updated.seenActivityAt } })
      })
      .catch(() => {})
      .finally(() => seeing.delete(key))
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
  const at = () => new Date().toISOString()
  /**
   * The owner's new order of bots (`fleet-order`): shown at once, then as the server answers. A refusal puts back the
   * order the server has.
   */
  const reorderBots = async (botIds: string[]) => {
    setActionError(null)
    const byId = new Map(stateOf().snapshot.bots.map((bot) => [bot.id, bot]))
    botIds.forEach((id, position) => {
      const bot = byId.get(id)
      if (bot && bot.position !== position)
        dispatch({ type: 'event', value: { type: 'bot.updated', at: at(), bot: { ...bot, position } } })
    })
    try {
      const { bots } = await window.api.fleetReorderBots(serverId, botIds)
      for (const bot of bots) dispatch({ type: 'event', value: { type: 'bot.updated', at: at(), bot } })
    } catch (error) {
      setActionError({ botId: null, environmentId: null, message: fleetErrorMessage(error) })
      await refresh().catch(() => {})
    }
  }
  const reorderEnvironments = async (environmentIds: string[]) => {
    setActionError(null)
    const byId = new Map(stateOf().snapshot.environments.map((environment) => [environment.id, environment]))
    environmentIds.forEach((id, position) => {
      const environment = byId.get(id)
      if (environment && environment.position !== position)
        dispatch({
          type: 'event',
          value: { type: 'environment.updated', at: at(), environment: { ...environment, position } },
        })
    })
    try {
      const { environments } = await window.api.fleetReorderEnvironments(serverId, environmentIds)
      for (const environment of environments)
        dispatch({ type: 'event', value: { type: 'environment.updated', at: at(), environment } })
    } catch (error) {
      setActionError({ botId: null, environmentId: null, message: fleetErrorMessage(error) })
      await refresh().catch(() => {})
    }
  }
  /** Gives a bot a picture, or with null takes it away; throws so the settings can say why. */
  const setBotAvatar = async (
    botId: string,
    avatar: Parameters<typeof window.api.fleetSetBotAvatar>[2] | null
  ): Promise<void> => {
    const bot = avatar
      ? await window.api.fleetSetBotAvatar(serverId, botId, avatar)
      : await window.api.fleetRemoveBotAvatar(serverId, botId)
    dispatch({ type: 'event', value: { type: 'bot.updated', at: at(), bot } })
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
    resyncBot,
    resyncAll,
    streamChanged,
    seeRun,
    seeThread,
    botAction,
    environmentAction,
    updateEnvironment,
    cancelEnvironmentUpdate,
    checkEnvironmentRuntimes,
    reorderBots,
    reorderEnvironments,
    setBotAvatar,
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
    const applyConnection = (serverId: FleetServerId, connection: FleetConnectionView) => {
      dispatchAll({ serverId, action: { type: 'connection', value: connection } })
      actionsFor(serverId).streamChanged(connection.state)
    }
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
        applyConnection(server.id, server.connection)
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
      applyConnection(serverId, connection)
      if (connection.state === 'connected') loadSnapshot(serverId)
    })
    const offEvent = window.api.onFleetEvent((serverId, event) => {
      const before = statesRef.current[serverId] ?? initialFleetState
      const fleet = actionsFor(serverId)
      dispatchAll({ serverId, action: { type: 'event', value: event } })
      // The bot restarted or its stream broke: what its runs and threads did meanwhile is read again too.
      if (event.type === 'transcript.reset' && held(before.transcripts[event.botId]))
        fleet.resyncBot(event.botId, before)
      if (
        event.type === 'routine_run.transcript.reset' &&
        held(before.runTranscripts[runTranscriptKey(event.botId, event.runId)])
      )
        void fleet.loadRunTranscript(event.botId, event.runId).catch(() => {})
      if (
        event.type === 'peer_thread.transcript.reset' &&
        held(before.runTranscripts[runTranscriptKey(event.botId, event.threadId)])
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
