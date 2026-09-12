import { createContext, useContext, useMemo, type ReactNode } from 'react'

interface OnboardingContextValue {
  isOpen: boolean
  openOnboarding: () => void
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null)

export function OnboardingProvider({
  isOpen,
  openOnboarding,
  children,
}: {
  isOpen: boolean
  openOnboarding: () => void
  children: ReactNode
}) {
  const value = useMemo(() => ({ isOpen, openOnboarding }), [isOpen, openOnboarding])
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>
}

const NOOP: OnboardingContextValue = { isOpen: false, openOnboarding: () => {} }

export function useOnboarding(): OnboardingContextValue {
  return useContext(OnboardingContext) ?? NOOP
}
