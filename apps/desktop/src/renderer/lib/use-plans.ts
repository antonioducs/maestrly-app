import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { PlanDecision, PlanReceived } from '../../preload'
import { type Tab as DrawerTab } from '@/components/Drawer'

type UsePlansParams = {
  setDrawerTabByConv: Dispatch<SetStateAction<Record<string, DrawerTab>>>
  setDrawerOpenByConv: Dispatch<SetStateAction<Record<string, boolean>>>
}

export function usePlans({ setDrawerTabByConv, setDrawerOpenByConv }: UsePlansParams) {
  const [plans, setPlans] = useState<Record<string, PlanReceived>>({})

  useEffect(() => {
    const offReceived = window.api.onPlanReceived((p) => {
      setPlans((prev) => ({ ...prev, [p.agentId]: p }))

      setDrawerTabByConv((prev) => ({ ...prev, [p.agentId]: 'plan' }))
      setDrawerOpenByConv((prev) => ({ ...prev, [p.agentId]: true }))
    })
    const offCleared = window.api.onPlanCleared(({ agentId }) => {
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
  }, [])

  const handleDecidePlan = useCallback((agentId: string, decision: PlanDecision) => {
    window.api.decidePlan(agentId, decision)
  }, [])

  const pendingPlanIds = useMemo(() => new Set(Object.keys(plans)), [plans])

  return { plans, handleDecidePlan, pendingPlanIds }
}
