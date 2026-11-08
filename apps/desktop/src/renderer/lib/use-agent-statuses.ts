import { useCallback, useEffect, useRef, useState } from 'react'
import { type HostId, LOCAL_HOST_ID } from '../../shared/host-key'
import { hostApi } from './hosts/host-context'

type AgentStatus = 'idle' | 'working' | 'ready' | 'waiting' | 'asking' | 'error'

type UseAgentStatusesParams = {
  refreshWorkspaces: () => Promise<unknown>
  activeId: string | null
  mainOverride: string | null
  hostId?: HostId
}

export function applyAttention(attention: Set<string>, conversationId: string): Set<string> {
  if (attention.has(conversationId)) return attention
  return new Set(attention).add(conversationId)
}

/** The host cleared the mark, seen from some computer. */
export function clearAttention(attention: Set<string>, conversationId: string): Set<string> {
  if (!attention.has(conversationId)) return attention
  const next = new Set(attention)
  next.delete(conversationId)
  return next
}

/** The host's marks, as listed, replace this window's; the conversation in front of the person is never marked. */
export function replaceAttention(
  attention: Set<string>,
  hostIds: readonly string[],
  focusedId: string | null
): Set<string> {
  const next = new Set(hostIds.filter((id) => id !== focusedId))
  if (next.size === attention.size && [...next].every((id) => attention.has(id))) return attention
  return next
}

export function useAgentStatuses({
  refreshWorkspaces,
  activeId,
  mainOverride,
  hostId = LOCAL_HOST_ID,
}: UseAgentStatusesParams) {
  const api = hostApi(hostId)
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})

  const [attention, setAttention] = useState<Set<string>>(() => new Set())
  const statusesRef = useRef<Record<string, AgentStatus>>({})
  statusesRef.current = statuses
  const focusedRef = useRef<string | null>(null)
  focusedRef.current = mainOverride ? null : activeId

  // The host keeps the mark: clearing it there clears it in the windows of every connected computer.
  const clearOnHost = useCallback(
    (conversationId: string) => void api.clearConversationAttention(conversationId).catch(() => undefined),
    [api]
  )
  const acknowledgeConversation = useCallback(
    (conversationId: string) => {
      setAttention((current) => clearAttention(current, conversationId))
      clearOnHost(conversationId)
    },
    [clearOnHost]
  )
  useEffect(() => {
    refreshWorkspaces()
    // Marks that changed while a listing was on its way are newer than the listing.
    let attentionRevision = 0
    let alive = true
    const syncAttention = (): void => {
      const revision = attentionRevision
      void api.listConversationAttention().then(
        (ids) => {
          if (!alive || revision !== attentionRevision) return
          const focusedId = focusedRef.current
          setAttention((current) => replaceAttention(current, ids, focusedId))
          // Only a window the person is looking at counts as having seen it.
          if (focusedId && ids.includes(focusedId) && document.hasFocus()) clearOnHost(focusedId)
        },
        () => undefined
      )
    }
    const offStatus = api.onStatus(({ agentId, status }) => {
      const previous = statusesRef.current[agentId]
      const endedTurn = (previous === 'working' || previous === 'waiting') && (status === 'ready' || status === 'error')
      if (endedTurn || status === 'asking' || status === 'waiting') {
        attentionRevision++
        if (agentId !== focusedRef.current) setAttention((current) => applyAttention(current, agentId))
        else if (document.hasFocus()) clearOnHost(agentId)
      }
      setStatuses((prev) => ({ ...prev, [agentId]: status as AgentStatus }))
    })
    const offAttention = api.onConversationAttention(({ conversationId, attention: marked }) => {
      attentionRevision++
      if (!marked) {
        setAttention((current) => clearAttention(current, conversationId))
        return
      }
      if (conversationId !== focusedRef.current) {
        setAttention((current) => applyAttention(current, conversationId))
      } else if (document.hasFocus()) clearOnHost(conversationId)
    })
    // Coming back to the window catches up with what other computers saw meanwhile, and the open conversation is seen.
    const onWindowFocus = (): void => syncAttention()
    window.addEventListener('focus', onWindowFocus)
    syncAttention()
    return () => {
      alive = false
      window.removeEventListener('focus', onWindowFocus)
      offStatus()
      offAttention()
    }
  }, [refreshWorkspaces, api, clearOnHost])

  useEffect(() => {
    const id = mainOverride ? null : activeId
    if (!id) return
    acknowledgeConversation(id)
  }, [activeId, mainOverride, acknowledgeConversation])

  return { statuses, attention, acknowledgeConversation }
}
