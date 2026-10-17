import { useEffect, useState } from 'react'

/**
 * Whether `active` has stayed true for `ms`. Reconnecting after the app comes back takes a moment; a notice held for
 * a while shows only when it takes longer than that.
 */
export function useHeldFor(active: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    setHeld(false)
    if (!active) return
    const timer = setTimeout(() => setHeld(true), ms)
    return () => clearTimeout(timer)
  }, [active, ms])
  return active && held
}
