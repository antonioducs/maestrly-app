import { useCallback, useEffect, useState } from 'react'
import type { FleetInstallerStatus } from '../../../shared/fleet-installer'

export function useFleetInstaller(): { status: FleetInstallerStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<FleetInstallerStatus | null>(null)
  const refresh = useCallback(async () => setStatus(await window.api.fleetInstallerStatus()), [])
  useEffect(() => {
    let active = true
    const off = window.api.onFleetInstallerStatus((next) => {
      if (active) setStatus(next)
    })
    void window.api
      .fleetInstallerStatus()
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch(() => {})
    return () => {
      active = false
      off()
    }
  }, [])
  return { status, refresh }
}
