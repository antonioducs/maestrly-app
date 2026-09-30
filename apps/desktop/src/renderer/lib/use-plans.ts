import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { PlanDecision, PlanReceived } from '../../preload'
import type { Tab as DrawerTab } from '@/components/Drawer'
import { hostApi } from '@/lib/hosts/host-context'
import { type HostId, LOCAL_HOST_ID } from '../../shared/host-key'

type UsePlansParams = {
  openDrawerTab: (convId: string, tab: DrawerTab) => void
  setDrawerOpenByConv: Dispatch<SetStateAction<Record<string, boolean>>>
  hostId?: HostId
}

export function usePlans({ openDrawerTab, setDrawerOpenByConv, hostId = LOCAL_HOST_ID }: UsePlansParams) {
  const api = hostApi(hostId)
  const [plans, setPlans] = useState<Record<string, PlanReceived>>({})

  useEffect(() => {
    const offReceived = api.onPlanReceived((p) => {
      setPlans((prev) => ({ ...prev, [p.agentId]: p }))

      // A plan waiting for review always surfaces: open its tab (if closed) and the drawer.
      openDrawerTab(p.agentId, 'plan')
      setDrawerOpenByConv((prev) => ({ ...prev, [p.agentId]: true }))
    })
    const offCleared = api.onPlanCleared(({ agentId }) => {
      setPlans((prev) => {
        if (!(agentId in prev)) return prev
        const next = { ...prev }
        delete next[agentId]
        return next
      })
    })
    return () => {
      offReceived()
      offCleared()
    }
  }, [openDrawerTab, api])

  const handleDecidePlan = useCallback(
    (agentId: string, decision: PlanDecision) => {
      api.decidePlan(agentId, decision)
    },
    [api]
  )

  const pendingPlanIds = useMemo(() => new Set(Object.keys(plans)), [plans])

  return { plans, handleDecidePlan, pendingPlanIds }
}
