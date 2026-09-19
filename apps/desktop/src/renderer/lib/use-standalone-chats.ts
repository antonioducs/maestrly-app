import { useCallback, useRef, useState } from 'react'
import type { StandaloneConversation } from '../../shared/conversation'

/** Standalone chats share lifecycle operations, but never belong to a workspace. */
export function useStandaloneChats() {
  const [conversations, setConversations] = useState<StandaloneConversation[]>([])
  const [archivedCount, setArchivedCount] = useState(0)
  const revision = useRef(0)
  const refresh = useCallback(async (includeArchived: boolean) => {
    const request = ++revision.current
    const list = await window.api.listStandaloneConversations(true)
    if (request !== revision.current) return
    setArchivedCount(list.filter((conversation) => conversation.archived === 1).length)
    setConversations(includeArchived ? list : list.filter((conversation) => conversation.archived !== 1))
  }, [])
  return { conversations, setConversations, archivedCount, refresh }
}
