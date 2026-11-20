import { useCallback, useEffect, useState } from 'react'
import type { FleetServerView } from '../../../shared/fleet-servers'
import type { HostId } from '../../../shared/host-key'
import { type LocalRoutine, type RoutineDraft, storedRoutinePlace } from '../../../shared/routines'
import { hostApi } from '@/lib/hosts/host-context'

export type DeviceIdOn = (serverId: string) => string | null

/** The device id this computer has on each paired server: how a record stored there names this computer. */
export function useFleetDeviceIds(): DeviceIdOn {
  const [byServer, setByServer] = useState<ReadonlyMap<string, string>>(() => new Map())
  useEffect(() => {
    let alive = true
    const apply = (servers: FleetServerView[]) => {
      if (!alive) return
      const next = new Map<string, string>()
      for (const server of servers) if (server.connection.deviceId) next.set(server.id, server.connection.deviceId)
      setByServer(next)
    }
    void window.api
      .fleetServers?.()
      .then(apply)
      .catch(() => {})
    const off = window.api.onFleetServers?.(apply)
    return () => {
      alive = false
      off?.()
    }
  }, [])
  return useCallback((serverId: string) => byServer.get(serverId) ?? null, [byServer])
}

/**
 * Creates on `targetHostId` the routine a proposal of `proposalHostId` describes, then marks the proposal created.
 * Two hosts take part, so a proposal that cannot be marked takes the new routine back: the proposal stays pending and
 * creating again makes no second routine.
 */
export async function createRoutineFromProposalOnHost({
  proposalHostId,
  targetHostId,
  proposalId,
  draft,
  originConversationId,
  originTitle,
  deviceIdOn,
}: {
  proposalHostId: HostId
  targetHostId: HostId
  proposalId: string
  draft: RoutineDraft
  /** The proposal's conversation, by its id on its own host. */
  originConversationId: string | null
  originTitle: string
  deviceIdOn: DeviceIdOn
}): Promise<LocalRoutine> {
  const target = hostApi(targetHostId)
  const created = await target.routinesCreate(
    draft,
    originConversationId
      ? {
          conversationId: originConversationId,
          title: originTitle.trim() || draft.title,
          via: 'proposal',
          ...storedRoutinePlace(targetHostId, proposalHostId, deviceIdOn),
        }
      : null
  )
  try {
    await hostApi(proposalHostId).routinesMarkProposalCreated(
      proposalId,
      created.id,
      storedRoutinePlace(proposalHostId, targetHostId, deviceIdOn)
    )
  } catch (error) {
    await target.routinesDelete(created.id).catch(() => {})
    throw error
  }
  return created
}
