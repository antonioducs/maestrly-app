import { useCallback, useRef, useState } from 'react'
import type { StandaloneConversation } from '../../shared/conversation'
import { type HostId, LOCAL_HOST_ID } from '../../shared/host-key'
import { hostApi } from './hosts/host-context'

/** Standalone chats share lifecycle operations, but never belong to a workspace. */
export function useStandaloneChats(hostId: HostId = LOCAL_HOST_ID) {
  const api = hostApi(hostId)
  const [conversations, setConversations] = useState<StandaloneConversation[]>([])
  const [archivedCount, setArchivedCount] = useState(0)
  const revision = useRef(0)
  const refresh = useCallback(
    async (includeArchived: boolean) => {
      const request = ++revision.current
      const list = await api.listStandaloneConversations(true)
      if (request !== revision.current) return
      setArchivedCount(list.filter((conversation) => conversation.archived === 1).length)
      setConversations(includeArchived ? list : list.filter((conversation) => conversation.archived !== 1))
    },
    [api]
  )
  return { conversations, setConversations, archivedCount, refresh }
}
