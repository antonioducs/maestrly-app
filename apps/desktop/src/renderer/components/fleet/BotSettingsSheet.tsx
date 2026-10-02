import type { MutableRefObject } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { BotSettings, type SettingsLeaveGuard } from './BotSettings'

/**
 * A bot's settings as a panel over its view, so the conversation and the computer stay where they are, still
 * streaming. Escape, the dark area and the close button all ask about unsaved changes before closing.
 */
export function BotSettingsSheet({
  bot,
  fleet,
  onClose,
  leaveGuard,
  onOpenScreen,
  onOpenEnvironment,
  onArchived,
}: {
  bot: FleetBot
  fleet: FleetController
  onClose: () => void
  /** Registered by the settings inside while they hold unsaved changes. */
  leaveGuard: MutableRefObject<SettingsLeaveGuard | null>
  onOpenScreen: () => void
  onOpenEnvironment?: () => void
  onArchived: () => void
}) {
  const { t } = useTranslation('fleet')
  const requestClose = () => {
    const guard = leaveGuard.current
    if (guard) guard(onClose)
    else onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <DialogContent
        showClose={false}
        aria-describedby={undefined}
        data-bot-settings-sheet
        // Asking opens a dialog of its own: wait out the press, or its focus change would dismiss that dialog at once.
        onPointerDownOutside={(event) => {
          event.preventDefault()
          window.setTimeout(requestClose, 0)
        }}
        className="left-auto right-0 top-0 flex h-full w-[min(780px,94vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 p-0 shadow-[-30px_0_60px_rgba(0,0,0,0.45)] data-[state=open]:slide-in-from-right-8 sm:rounded-none"
      >
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border pl-[18px] pr-3">
          <DialogTitle className="text-[15px] leading-none tracking-normal">
            {t('settingsSheet.title', { name: bot.name })}
          </DialogTitle>
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto size-[30px] text-muted-foreground hover:text-foreground"
            aria-label={t('settingsSheet.close')}
            title={t('settingsSheet.close')}
            onClick={requestClose}
          >
            <X />
          </Button>
        </header>
        <BotSettings
          key={bot.id}
          bot={bot}
          fleet={fleet}
          onOpenScreen={onOpenScreen}
          onOpenEnvironment={onOpenEnvironment}
          onArchived={onArchived}
          leaveGuard={leaveGuard}
        />
      </DialogContent>
    </Dialog>
  )
}
