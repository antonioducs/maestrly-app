/** Installs the shared chat UI context once per window, following the active locale. */
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatUiProvider, type ChatUiContextValue } from '@maestrly/chat-ui'
import { chatUiLabels } from '@/lib/chat-ui-labels'

export function ChatUiRoot({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const value = useMemo<ChatUiContextValue>(
    () => ({
      labels: chatUiLabels(),
      openExternal: (url) => void window.api.openExternalUrl(url),
      locale: i18n.language,
    }),
    [i18n.language]
  )
  return <ChatUiProvider value={value}>{children}</ChatUiProvider>
}
