import { fleetErrorMessage } from '@/lib/fleet/errors'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { BotFields, type BotFieldsValue } from './BotFields'

export function CreateBotDialog({
  open,
  onClose,
  onCreated,
  fleet,
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
  fleet: FleetController
}) {
  const { t } = useTranslation('fleet')
  const [value, setValue] = useState<BotFieldsValue>({ name: '', instructions: '', ceiling: 'auto', talksTo: [] })
  const [created, setCreated] = useState<FleetBot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = created && (fleet.state.snapshot.bots.find((bot) => bot.id === created.id) ?? created)
  useEffect(() => {
    if (!open) {
      setValue({ name: '', instructions: '', ceiling: 'auto', talksTo: [] })
      setCreated(null)
      setError('')
    }
  }, [open])
  useEffect(() => {
    if (open && current?.setup.step === 'ready') onCreated(current.id)
  }, [open, current?.id, current?.setup.step, onCreated])
  async function submit() {
    if (!value.name.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const bot = await window.api.fleetCreateBot({
        name: value.name.trim(),
        instructions: value.instructions.trim(),
        ceiling: value.ceiling,
        talksTo: value.talksTo,
      })
      setCreated(bot)
      fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot } })
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('create.title')}</DialogTitle>
          <DialogDescription>{created ? t('create.progressDescription') : t('create.description')}</DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="space-y-3 text-sm">
            {(['container', 'desktop', 'profile', 'ready'] as const).map((step, index) => (
              <div
                key={step}
                className={`flex items-center gap-2 ${['container', 'desktop', 'profile', 'ready'].indexOf(current?.setup.step ?? '') >= index ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                <span aria-hidden="true">●</span>
                {t(`create.step.${step}`)}
              </div>
            ))}
            {current?.setup.step === 'failed' && (
              <p role="alert" className="text-destructive">
                {current.setup.errorMessage ?? t('create.failed')}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('create.closeNote')}</p>
          </div>
        ) : (
          <BotFields value={value} onChange={setValue} bots={fleet.state.snapshot.bots} />
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {created ? t('create.close') : t('create.cancel')}
          </Button>
          {!created && (
            <Button disabled={!value.name.trim() || busy} onClick={() => void submit()}>
              {t('create.submit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
