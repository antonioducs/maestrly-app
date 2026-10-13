import { router } from 'expo-router'
import { useEffect } from 'react'
import { useServers, type Current } from './ServersProvider'

/**
 * Opens a bot or a chat from a link, on the server it names: that server becomes the active one first. A server this
 * phone no longer knows opens the home screen of the active one. Returns false when no server is paired.
 */
export function useOpenLink(target: Current | null, serverId: string | undefined): boolean {
  const { servers, active, controller, activate, setCurrent } = useServers()
  const known = serverId ? servers.some((server) => server.id === serverId) : false
  useEffect(() => {
    if (known && serverId && active?.id !== serverId) {
      void activate(serverId)
      return
    }
    // The controllers of the server the link names: those of the server active before are about to stop.
    if (!controller || (known && controller.source.serverId !== serverId)) return
    if (target && (!serverId || known)) setCurrent(target)
    router.replace('/home')
  }, [known, serverId, active?.id, controller, target?.kind, target && 'id' in target ? target.id : null])
  return servers.length > 0
}
