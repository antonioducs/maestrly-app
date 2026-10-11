import { useEffect, useMemo, useState } from 'react'
import type { HostTransferView } from '../../../shared/host-transfers'
import { transfersOfHost } from './files-model'

/** The transfers of a host in this computer's queue, newest first, as the queue changes. */
export function useHostTransfers(hostId: string): HostTransferView[] {
  const [all, setAll] = useState<HostTransferView[]>([])
  useEffect(() => {
    let alive = true
    void window.api.transfersList().then((transfers) => alive && setAll(transfers))
    const off = window.api.onTransfersChanged(setAll)
    return () => {
      alive = false
      off()
    }
  }, [])
  return useMemo(() => transfersOfHost(all, hostId), [all, hostId])
}
