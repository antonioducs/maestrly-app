import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { FleetInteractionResolution } from '@maestrly/bot-fleet-protocol'
import { emptyTranscript, fleetReducer, initialFleetState } from './state'
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
    void window.api
      .fleetGetDigest()
      .then((digest) => {
        if (active) dispatch({ type: 'digest', value: digest })
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
      dispatch({ type: 'event', value: event })
      if (event.type === 'transcript.reset' && stateRef.current.transcripts[event.botId]?.loaded) {
        void loadTranscript(event.botId).catch(() => {})
      }
    })
    const offDigest = window.api.onFleetDigest((digest) => dispatch({ type: 'digest', value: digest }))
    return () => {
      active = false
      offConnection()
      offEvent()
      offDigest()
    }
  }, [loadTranscript])
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
    botAction,
    environmentAction,
    resolve,
    actionError,
  }
}
export type FleetController = ReturnType<typeof useFleet>
