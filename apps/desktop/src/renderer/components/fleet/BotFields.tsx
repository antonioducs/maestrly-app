import { useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ceilingValues, nextRadioIndex } from '@/lib/fleet/forms'

export type BotFieldsValue = {
  name: string
  instructions: string
  ceiling: FleetBot['ceiling']
  talksTo: string[]
}
export function BotFields({
  value,
  onChange,
  bots,
  selfId,
  role,
  onRoleChange,
}: {
  value: BotFieldsValue
  onChange: (value: BotFieldsValue) => void
  bots: FleetBot[]
  selfId?: string
  role?: string
  onRoleChange?: (value: string) => void
}) {
  const { t } = useTranslation('fleet')
  const radios = useRef<Array<HTMLButtonElement | null>>([])
  const set = (patch: Partial<BotFieldsValue>) => onChange({ ...value, ...patch })
  const onRadioKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextRadioIndex(index, event.key, ceilingValues.length)
    if (next === null) return
    event.preventDefault()
    set({ ceiling: ceilingValues[next] })
    radios.current[next]?.focus()
  }
  return (
    <div className="space-y-5">
      <label className="block text-sm font-medium">
        {t('botFields.name')}
        <Input
          className="mt-1 bg-surface-elevated"
          value={value.name}
          maxLength={40}
          onChange={(event) => set({ name: event.target.value })}
        />
      </label>
      {onRoleChange && (
        <label className="block text-sm font-medium">
          {t('botFields.role')}
          <Input
            className="mt-1 bg-surface-elevated"
            value={role ?? ''}
            maxLength={80}
            onChange={(event) => onRoleChange(event.target.value)}
          />
        </label>
      )}
      <label className="block text-sm font-medium">
        {t('botFields.instructions')}
        <textarea
          className="mt-1 min-h-24 w-full rounded-md border border-input bg-surface-elevated p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={value.instructions}
          maxLength={8000}
          onChange={(event) => set({ instructions: event.target.value })}
        />
      </label>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t('botFields.ceiling')}</legend>
        <div role="radiogroup" aria-label={t('botFields.ceiling')} className="grid gap-2 sm:grid-cols-3">
          {ceilingValues.map((ceiling, index) => (
            <button
              ref={(node) => {
                radios.current[index] = node
              }}
              key={ceiling}
              role="radio"
              aria-checked={value.ceiling === ceiling}
              tabIndex={value.ceiling === ceiling ? 0 : -1}
              type="button"
              onClick={() => set({ ceiling })}
              onKeyDown={(event) => onRadioKey(event, index)}
              className={`rounded-lg border p-3 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring ${value.ceiling === ceiling ? 'border-border-strong bg-surface-elevated' : 'border-border bg-surface hover:bg-accent'}`}
            >
              <strong className="block">{t(`ceiling.${ceiling}.title`)}</strong>
              <span className="mt-1 block text-muted-foreground">{t(`ceiling.${ceiling}.description`)}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t('botFields.talksTo')}</legend>
        <div className="flex flex-wrap gap-2">
          {bots
            .filter((bot) => bot.id !== selfId)
            .map((bot) => (
              <Button
                key={bot.id}
                size="sm"
                variant={value.talksTo.includes(bot.id) ? 'secondary' : 'outline'}
                aria-pressed={value.talksTo.includes(bot.id)}
                onClick={() =>
                  set({
                    talksTo: value.talksTo.includes(bot.id)
                      ? value.talksTo.filter((id) => id !== bot.id)
                      : [...value.talksTo, bot.id],
                  })
                }
              >
                {bot.name}
              </Button>
            ))}
          {bots.filter((bot) => bot.id !== selfId).length === 0 && (
            <span className="text-xs text-muted-foreground">{t('botFields.noPeers')}</span>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('botFields.talksNote')}</p>
      </fieldset>
    </div>
  )
}
