import { Paperclip } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Bot, ModelCatalogEntry } from '@maestrly/host-protocol'
import {
  BotPermModePicker,
  ChatComposer,
  ChatModelChip,
  ChatPlusMenu,
  ChatReasoningPicker,
  type ComposerCommand,
  type PlusMenuItem,
} from '@maestrly/chat-ui'
import { useT } from '../../i18n'
import { recommendedSelection } from '../accounts/ModelPicker'
import { FullVmConfirm } from './FullVmConfirm'

/**
 * The Bot's composer: the shared box with this application's pickers in its slots. Model,
 * effort and permission are persisted on the bot through `bot.update`, which the Host refuses
 * while a turn is running — so the pickers say so instead of failing after the click.
 */
export function Composer({
  bot,
  onBotUpdate,
  connected,
  value,
  attachments,
  removeAttachment,
  onChange,
  send,
  stop,
  attach,
  active,
  cancelling,
  disabled,
  reason,
  busy,
  voice,
  commands = [],
  onPickCommand,
  extraMenu = [],
  metaSlot,
  leftExtra,
}: {
  /** Absent for a team conversation: the box alone, without per-bot pickers. */
  bot?: Bot
  onBotUpdate?: (bot: Bot) => void
  connected: boolean
  value: string
  attachments: { path: string; name: string; size: number }[]
  removeAttachment: (path: string) => void
  onChange: (value: string) => void
  send: () => void
  stop: () => void
  attach: () => void
  active: boolean
  cancelling: boolean
  disabled: boolean
  reason?: string
  busy: boolean
  /** The microphone, when this Host can transcribe. Absent keeps the composer exactly as before. */
  voice?: ReactNode
  commands?: ComposerCommand[]
  onPickCommand?: (command: ComposerCommand) => void
  extraMenu?: PlusMenuItem[]
  metaSlot?: ReactNode
  leftExtra?: ReactNode
}) {
  const t = useT()
  const [models, setModels] = useState<ModelCatalogEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmFull, setConfirmFull] = useState(false)
  useEffect(() => {
    if (!connected || !bot) return
    let alive = true
    const request = bot.accountId
      ? window.bot.bot({ method: 'account.models', params: { accountId: bot.accountId } })
      : window.bot.bot({ method: 'bot.models.list', params: { botId: bot.id } })
    void request.then((values) => alive && setModels(values)).catch(() => alive && setModels([]))
    return () => {
      alive = false
    }
  }, [bot?.id, bot?.accountId, connected])

  const update = async (patch: Record<string, unknown>) => {
    if (!bot) return
    setSaving(true)
    setError('')
    try {
      onBotUpdate?.(
        await window.bot.bot({
          method: 'bot.update',
          params: { botId: bot.id, expectedRevision: bot.revision, ...patch },
        })
      )
    } catch (failure) {
      setError(String(failure))
    } finally {
      setSaving(false)
    }
  }
  const pickerBusy = !connected || saving || active || !!bot?.activeTurnId
  const pickerReason = active || bot?.activeTurnId ? t('pickerBusyReason') : undefined
  const current = models.find((model) => model.id === bot?.model?.model)
  const options = useMemo(
    () =>
      models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        efforts: model.efforts,
        defaultEffort: model.defaultEffort,
      })),
    [models]
  )
  const menu: PlusMenuItem[] = [
    {
      id: 'attach',
      label: t('attach'),
      icon: <Paperclip className="h-4 w-4" />,
      onSelect: attach,
      disabled: disabled || busy || active,
    },
    ...extraMenu,
  ]
  return (
    <>
      <ChatComposer
        value={value}
        onChange={onChange}
        onSend={send}
        onStop={stop}
        streaming={active}
        stopping={cancelling}
        disabled={disabled}
        disabledReason={reason ?? t('connectionReason')}
        busy={busy}
        attachments={attachments.map((file) => ({ id: file.path, name: file.name, size: file.size }))}
        onRemoveAttachment={removeAttachment}
        commands={commands}
        onPickCommand={onPickCommand}
        micSlot={voice}
        metaSlot={metaSlot}
        leftSlot={
          <>
            {(bot || extraMenu.length > 0) && <ChatPlusMenu items={menu} title={t('add')} />}
            {bot && (
              <>
                <ChatModelChip
                  models={options}
                  value={bot.model ? { model: bot.model.model, effort: bot.model.effort } : null}
                  disabled={pickerBusy || !models.length}
                  disabledReason={pickerReason}
                  onChange={(next) => {
                    const selection = recommendedSelection(models, {
                      model: next.model,
                      effort: next.effort as never,
                      source: 'custom',
                    })
                    if (selection) void update({ model: { ...selection, source: 'custom' } })
                  }}
                />
                {!!current?.efforts.length && (
                  <ChatReasoningPicker
                    efforts={current.efforts}
                    value={bot.model?.effort}
                    disabled={pickerBusy}
                    disabledReason={pickerReason}
                    defaultLabel={t('effortDefault')}
                    onChange={(effort) =>
                      bot.model &&
                      void update({ model: { ...bot.model, ...(effort ? { effort } : {}), source: 'custom' } })
                    }
                  />
                )}
                <BotPermModePicker
                  value={bot.permissionMode === 'full-vm' ? 'full' : 'ask'}
                  disabled={pickerBusy}
                  disabledReason={pickerReason}
                  onChange={(mode) => {
                    if (mode === 'ask') void update({ permissionMode: 'ask' })
                    else setConfirmFull(true)
                  }}
                />
              </>
            )}
            {leftExtra}
          </>
        }
      />
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {confirmFull && (
        <FullVmConfirm
          busy={saving}
          onCancel={() => setConfirmFull(false)}
          onConfirm={() => {
            setConfirmFull(false)
            void update({ permissionMode: 'full-vm', confirmFullVm: true })
          }}
        />
      )}
    </>
  )
}
