import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Hand, ShieldAlert, TerminalSquare } from 'lucide-react'
import { ChatPermModePicker as SharedPermModePicker, type PermMode } from '@maestrly/chat-ui'
import type { ChatPermMode } from '../../../shared/chat'

/** Desktop wrapper: loads and persists the conversation's mode; the picker itself is shared with the Bot. */
export function ChatPermModePicker({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation('chat')
  const [mode, setMode] = useState<ChatPermMode>('ask')
  useEffect(() => {
    window.api.chatGetPermMode(conversationId).then(setMode)
  }, [conversationId])
  const modes = useMemo<PermMode<ChatPermMode>[]>(
    () => [
      { id: 'ask', label: t('perm.askLabel'), description: t('perm.askDesc'), icon: <Hand className="h-3.5 w-3.5" /> },
      { id: 'auto', label: t('perm.autoLabel'), description: t('perm.autoDesc'), icon: <TerminalSquare className="h-3.5 w-3.5" /> },
      { id: 'full', label: t('perm.fullLabel'), description: t('perm.fullDesc'), icon: <ShieldAlert className="h-3.5 w-3.5" />, danger: true },
    ],
    [t]
  )
  return (
    <SharedPermModePicker
      modes={modes}
      value={mode}
      title={t('perm.buttonTitle')}
      onChange={(id) => {
        setMode(id)
        window.api.chatSetPermMode(conversationId, id)
      }}
    />
  )
}
