import { createContext, useContext } from 'react'
import { ptBR, type TranslationKey } from './pt-BR'
import { en } from './en'
export const LocaleContext = createContext<'pt-BR' | 'en'>('pt-BR')
export function useT() {
  const locale = useContext(LocaleContext)
  return (key: TranslationKey): string => (locale === 'en' ? en : ptBR)[key]
}
