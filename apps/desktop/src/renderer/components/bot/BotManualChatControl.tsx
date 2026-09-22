import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, Unlock } from 'lucide-react'
import type { Conversation } from '../../../shared/conversation'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/confirm-dialog'

/**
 * Releasing a bot chat for the person's own messages, and closing it again.
 *
 * This is not a pause: the bot keeps the conversation and may send at any moment. The confirmation
 * says so, because nothing here tells the bot what the person writes — asking it to read the chat
 * again is the person's move, and they make it knowing that.
 */
export function BotManualChatControl({ conversation }: { conversation: Conversation }) {
  const { t } = useTranslation('ui')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!conversation.botOrigin || conversation.botManagementState !== 'active') return null
  const name = conversation.botOrigin.botName
  const shared = !!conversation.botManualChatEnabled

  const apply = async (enabled: boolean) => {
    setBusy(true)
    setError('')
    try {
      // The composer follows the conversation this writes, never this click.
      await window.api.botSetManualChatEnabled(conversation.id, enabled)
      setConfirming(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('bots.releaseFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-sky-300" role="status">
          {shared ? t('bots.shared', { name }) : t('bots.composerManaged', { name })}
        </p>
        {error && (
          <span role="alert" title={error} className="max-w-40 shrink-0 truncate text-xs text-destructive">
            {error}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          disabled={busy}
          onClick={() => (shared ? void apply(false) : setConfirming(true))}
        >
          {shared ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
          {t(shared ? 'bots.block' : 'bots.release')}
        </Button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t('bots.releaseTitle')}
          message={t('bots.releaseBody', { name })}
          confirmLabel={t('bots.release')}
          busy={busy}
          onCancel={() => {
            if (busy) return
            setError('')
            setConfirming(false)
          }}
          onConfirm={() => void apply(true)}
        />
      )}
    </>
  )
}
