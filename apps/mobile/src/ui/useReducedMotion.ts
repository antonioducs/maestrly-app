import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/** The system's Reduce Motion setting; animations become instant or stop while it is on. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let alive = true
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduced(value)
    })
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => {
      alive = false
      subscription.remove()
    }
  }, [])
  return reduced
}
