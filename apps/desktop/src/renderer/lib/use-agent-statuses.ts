import { useCallback, useEffect, useRef, useState } from 'react'

type AgentStatus = 'idle' | 'working' | 'ready' | 'waiting' | 'asking' | 'error'

type UseAgentStatusesParams = {
  refreshWorkspaces: () => Promise<unknown>
  activeId: string | null
  mainOverride: string | null

  chatGptVisibleConversationId?: string | null
}

export interface AgentAttentionState {
  normalAttention: Set<string>
  companionAttention: Set<string>
}

export function attentionFor(state: AgentAttentionState): Set<string> {
  return new Set([...state.normalAttention, ...state.companionAttention])
}

export function applyNormalAttention(state: AgentAttentionState, conversationId: string): AgentAttentionState {
  if (state.normalAttention.has(conversationId)) return state
  return {
    normalAttention: new Set(state.normalAttention).add(conversationId),
    companionAttention: state.companionAttention,
  }
}

export function applyChatGptTurnCompleted(
  state: AgentAttentionState,
  conversationId: string,
  chatGptVisibleConversationId: string | null
): AgentAttentionState {
  if (conversationId === chatGptVisibleConversationId) return state
  const companionAttention = new Set(state.companionAttention).add(conversationId)
  return { normalAttention: state.normalAttention, companionAttention }
}

export function clearChatGptAttention(state: AgentAttentionState, conversationId: string): AgentAttentionState {
  const companionAttention = new Set(state.companionAttention)
  companionAttention.delete(conversationId)
  if (companionAttention.size === state.companionAttention.size) return state
  return { normalAttention: state.normalAttention, companionAttention }
}

export function clearConversationAttention(state: AgentAttentionState, conversationId: string): AgentAttentionState {
  if (!state.normalAttention.has(conversationId) && !state.companionAttention.has(conversationId)) return state
  const normalAttention = new Set(state.normalAttention)
  const companionAttention = new Set(state.companionAttention)
  normalAttention.delete(conversationId)
  companionAttention.delete(conversationId)
  return { normalAttention, companionAttention }
}

export function isChatGptVisibleForAttention(
  conversationId: string,
  mainVisible: boolean | undefined,
  localVisibleConversationId: string | null
): boolean {
  return mainVisible ?? conversationId === localVisibleConversationId
}

export function reconcileChatGptAttention(
  state: AgentAttentionState,
  conversationId: string,
  mainVisible: boolean | undefined,
  localVisibleConversationId: string | null
): AgentAttentionState {
  return isChatGptVisibleForAttention(conversationId, mainVisible, localVisibleConversationId)
    ? clearChatGptAttention(state, conversationId)
    : applyChatGptTurnCompleted(state, conversationId, null)
}

export function useAgentStatuses({
  refreshWorkspaces,
  activeId,
  mainOverride,
  chatGptVisibleConversationId = null,
}: UseAgentStatusesParams) {
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})

  const [attentionState, setAttentionState] = useState<AgentAttentionState>(() => ({
    normalAttention: new Set(),
    companionAttention: new Set(),
  }))
  const statusesRef = useRef<Record<string, AgentStatus>>({})
  statusesRef.current = statuses
  const focusedRef = useRef<string | null>(null)
  focusedRef.current = mainOverride ? null : activeId
  const chatGptVisibleRef = useRef<string | null>(null)
  chatGptVisibleRef.current = chatGptVisibleConversationId

  const acknowledgementRevisionRef = useRef(new Map<string, number>())
  const acknowledgeConversation = useCallback((conversationId: string) => {
    const revisions = acknowledgementRevisionRef.current
    revisions.set(conversationId, (revisions.get(conversationId) ?? 0) + 1)
    setAttentionState((state) => clearConversationAttention(state, conversationId))
  }, [])
  useEffect(() => {
    refreshWorkspaces()
    const offStatus = window.api.onStatus(({ agentId, status }) => {
      const endedTurn = statusesRef.current[agentId] === 'working' && (status === 'ready' || status === 'error')
      if ((endedTurn || status === 'asking') && agentId !== focusedRef.current) {
        setAttentionState((state) => applyNormalAttention(state, agentId))
      }
      setStatuses((prev) => ({ ...prev, [agentId]: status as AgentStatus }))
    })
    const offChatGptCompletion = window.api.onChatGptWebTurnCompleted(({ conversationId }) => {
      if (!conversationId) return
      const acknowledgementRevision = acknowledgementRevisionRef.current.get(conversationId) ?? 0

      const applyVisibility = (mainVisible: boolean | undefined) => {
        if ((acknowledgementRevisionRef.current.get(conversationId) ?? 0) !== acknowledgementRevision) return
        setAttentionState((state) =>
          reconcileChatGptAttention(state, conversationId, mainVisible, chatGptVisibleRef.current)
        )
      }
      void window.api.isChatGptVisible(conversationId).then(applyVisibility, () => applyVisibility(undefined))
    })
    return () => {
      offStatus()
      offChatGptCompletion()
    }
  }, [refreshWorkspaces])

  useEffect(() => {
    const id = chatGptVisibleConversationId
    if (!id) return
    let alive = true
    const clearIfVisible = (mainVisible: boolean | undefined) => {
      if (!alive || !isChatGptVisibleForAttention(id, mainVisible, chatGptVisibleRef.current)) return
      setAttentionState((state) => clearChatGptAttention(state, id))
    }
    // A modal can leave the renderer's local derivation pointing at ChatGPT while main has already moved
    // the native view offscreen. Never clear on that local signal unless the canonical query confirms it.
    void window.api.isChatGptVisible(id).then(clearIfVisible, () => clearIfVisible(undefined))
    return () => {
      alive = false
    }
  }, [chatGptVisibleConversationId])

  useEffect(() => {
    const id = mainOverride ? null : activeId
    if (!id) return
    acknowledgeConversation(id)
  }, [activeId, mainOverride, acknowledgeConversation])

  return { statuses, attention: attentionFor(attentionState), acknowledgeConversation }
}
