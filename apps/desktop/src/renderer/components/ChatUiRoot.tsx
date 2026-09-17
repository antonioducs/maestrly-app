/** Installs the shared chat UI context once per window, following the active locale. */
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatUiProvider, type ChatUiContextValue } from '@maestrly/chat-ui'
import { chatUiLabels } from '@/lib/chat-ui-labels'
import { imageResultToObjectUrl, withImageFetchSlot } from '@/lib/binary-image'

/** Tool image references are the JSON the desktop itself produced in tool-part-view.ts. */
async function resolveToolImage(ref: string, signal = new AbortController().signal) {
  let parsed: { conversationId: string; messageId: string; toolPartId: string; imageId: string }
  try {
    parsed = JSON.parse(ref)
  } catch {
    return null
  }
  const result = await withImageFetchSlot(
    () => window.api.chatToolImage(parsed.conversationId, parsed.messageId, parsed.toolPartId, parsed.imageId),
    signal
  )
  if (!result.ok) return null
  const src = imageResultToObjectUrl(result)
  return { src, release: () => URL.revokeObjectURL(src) }
}

export function ChatUiRoot({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const value = useMemo<ChatUiContextValue>(
    () => ({
      labels: chatUiLabels(),
      openExternal: (url) => void window.api.openExternalUrl(url),
      resolveImage: resolveToolImage,
      locale: i18n.language,
    }),
    [i18n.language]
  )
  return <ChatUiProvider value={value}>{children}</ChatUiProvider>
}
