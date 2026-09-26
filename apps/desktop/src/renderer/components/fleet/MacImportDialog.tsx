import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import type { MacInventory, MacImportReport } from '../../../shared/fleet-provisioning'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  emptyImportChoice,
  settleMacImport,
  hasImportChoice,
  importGroups,
  recommendedImportChoice,
  useMacInventory,
  type BotProvisioning,
  type ImportChoice,
  type ImportGroup,
} from '@/lib/fleet/provisioning'
import { MacImportPicker } from './MacImportPicker'
import { BotLoginDialog } from './BotLoginDialog'

export function MacImportFlow({
  bot,
  inventory,
  choice,
  autoStart = false,
  onDone,
}: {
  bot: FleetBot
  inventory: MacInventory
  choice: ImportChoice
  autoStart?: boolean
  onDone: () => void
}) {
  const { t } = useTranslation('fleet')
  const [report, setReport] = useState<MacImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [settled, setSettled] = useState(false)
  const [error, setError] = useState('')
  const [loginIndex, setLoginIndex] = useState<number | null>(null)
  const started = useRef(false)
  const alive = useRef(true)
  const logins = inventory.logins.filter((item) => choice.loginIds.includes(item.id))
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function send() {
    if (started.current) return
    started.current = true
    setBusy(true)
    setError('')
    const { loginIds: _, ...selection } = choice
    await settleMacImport(
      () => window.api.fleetImportFromMac(bot.id, selection),
      (result) => {
        if (alive.current) setReport(result)
      },
      (message) => {
        if (alive.current) setError(message)
      },
      () => {
        if (!alive.current) return
        setBusy(false)
        setSettled(true)
        setLoginIndex(0)
      }
    )
  }
  useEffect(() => {
    if (autoStart) void send()
  }, [autoStart])
  const login = loginIndex === null ? null : logins[loginIndex]
  return (
    <div className="space-y-3">
      {busy && <p role="status">{t('provisioning.sending')}</p>}
      {report && (
        <ul className="space-y-2" aria-label={t('provisioning.fromMac')}>
          {(['accounts', 'skills', 'mcpServers'] as const).flatMap((group) =>
            report[group].map((item) => (
              <li key={`${group}:${item.id}`} className="rounded border border-border p-2 text-sm">
                {item.name} · {t(`provisioning.outcome.${item.outcome}`, { error: item.error })}
              </li>
            ))
          )}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!settled && (
        <Button disabled={busy || !hasImportChoice(choice)} onClick={() => void send()}>
          {t('provisioning.send')}
        </Button>
      )}
      {login && (
        <BotLoginDialog
          key={login.id}
          bot={bot}
          kind={login.kind}
          hint={login.email}
          open
          onClose={() => setLoginIndex((index) => (index ?? 0) + 1)}
        />
      )}
      {settled && !login && <Button onClick={onDone}>{t('provisioning.finish')}</Button>}
    </div>
  )
}

export function MacImportDialog({
  bot,
  groups = importGroups,
  lists,
  onClose,
}: {
  bot: FleetBot
  groups?: ImportGroup[]
  lists: BotProvisioning
  onClose: () => void
}) {
  const { t } = useTranslation('fleet')
  const { inventory, error } = useMacInventory()
  const [selectedChoice, setChoice] = useState<ImportChoice | null>(null)
  const choice = selectedChoice ?? (inventory ? recommendedImportChoice(inventory, groups) : emptyImportChoice())
  const [sending, setSending] = useState(false)
  function close() {
    lists.refresh()
    onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('provisioning.fromMac')}</DialogTitle>
          <DialogDescription>{t('provisioning.fromMacHint')}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {inventory &&
          (sending ? (
            <MacImportFlow bot={bot} inventory={inventory} choice={choice} autoStart onDone={close} />
          ) : (
            <>
              <MacImportPicker
                inventory={inventory}
                value={choice}
                onChange={setChoice}
                groups={groups}
                lists={lists}
              />
              <Button disabled={!hasImportChoice(choice)} onClick={() => setSending(true)}>
                {t('provisioning.send')}
              </Button>
            </>
          ))}
        <p className="text-xs text-muted-foreground">{t('provisioning.finishLater')}</p>
      </DialogContent>
    </Dialog>
  )
}
