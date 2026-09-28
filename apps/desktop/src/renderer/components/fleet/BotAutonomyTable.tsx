import { useId, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Info } from 'lucide-react'
import { autonomyAt, autonomyCapabilities } from '@/lib/fleet/bot-settings'
import { ceilingValues, nextRadioIndex, type Ceiling } from '@/lib/fleet/forms'
import { cn } from '@/lib/utils'

// Wide: a legend column, then one column per ceiling. Narrow: the options stack and only the chosen column shows.
const columns = 'grid-cols-[minmax(0,1fr)_3.5rem] @xl:grid-cols-[minmax(11rem,1.25fr)_repeat(3,minmax(0,1fr))]'

function Mark({ allowed, strong, caution }: { allowed: boolean; strong: boolean; caution: boolean }) {
  return allowed ? (
    <span
      className={cn(
        'flex size-[18px] items-center justify-center rounded-full transition-[opacity,background-color] duration-200 motion-reduce:transition-none',
        caution && strong ? 'bg-amber-300 text-amber-950' : 'bg-primary text-primary-foreground',
        strong ? 'opacity-100' : 'opacity-40'
      )}
    >
      <Check className="size-[11px]" strokeWidth={3} aria-hidden="true" />
    </span>
  ) : (
    <span
      className={cn(
        'block size-[18px] rounded-full border-[1.5px] border-dashed border-foreground/35 transition-opacity duration-200 motion-reduce:transition-none',
        strong ? 'opacity-100' : 'opacity-40'
      )}
    />
  )
}

/**
 * How far a bot goes without asking, as a table of what it does on its own at each ceiling: the chosen column stands
 * out and a sentence under it says the same in words. Full access is shown in amber.
 */
export function BotAutonomyTable({
  value,
  onChange,
  labelledBy,
}: {
  value: Ceiling
  onChange: (value: Ceiling) => void
  labelledBy: string
}) {
  const { t, i18n } = useTranslation('fleet')
  const id = useId()
  const radios = useRef<Array<HTMLButtonElement | null>>([])
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' })
  const described = (ceiling: Ceiling) => {
    const { alone, asks } = autonomyAt(ceiling)
    const verbs = (rows: readonly string[]) => list.format(rows.map((row) => t(`botSettings.autonomy.verb.${row}`)))
    return ceiling === 'full'
      ? { lead: t('botSettings.autonomy.summaryFullLead'), rest: t('botSettings.autonomy.summaryFull'), asks: null }
      : {
          lead: t('botSettings.autonomy.summaryAlone'),
          rest: `${verbs(alone)}.`,
          asks: { lead: t('botSettings.autonomy.summaryAsks'), rest: `${verbs(asks)}.` },
        }
  }
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextRadioIndex(index, event.key, ceilingValues.length)
    if (next === null) return
    event.preventDefault()
    onChange(ceilingValues[next])
    radios.current[next]?.focus()
  }
  const band = (ceiling: Ceiling) =>
    ceiling === value ? (ceiling === 'full' ? 'bg-amber-400/10' : 'bg-foreground/[0.065]') : ''
  const chosen = described(value)
  return (
    <div className="@container rounded-xl border border-border bg-foreground/[0.025] px-2 pt-2">
      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        className={cn('flex flex-col gap-1.5 pb-2 @xl:grid @xl:gap-0 @xl:pb-0', columns)}
      >
        <div
          aria-hidden="true"
          className="hidden flex-col justify-end gap-2 px-2.5 py-3 text-xs text-muted-foreground @xl:flex"
        >
          <span className="flex items-center gap-2">
            <Mark allowed strong caution={false} />
            {t('botSettings.autonomy.alone')}
          </span>
          <span className="flex items-center gap-2">
            <Mark allowed={false} strong caution={false} />
            {t('botSettings.autonomy.asks')}
          </span>
        </div>
        {ceilingValues.map((ceiling, index) => {
          const selected = value === ceiling
          const text = described(ceiling)
          return (
            <button
              key={ceiling}
              ref={(node) => {
                radios.current[index] = node
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-describedby={`${id}-${ceiling}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(ceiling)}
              onKeyDown={(event) => onKey(event, index)}
              className={cn(
                'flex flex-col gap-0.5 rounded-lg border border-border px-3 pb-3 pt-3.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @xl:rounded-b-none @xl:border-0',
                selected && 'border-border-strong',
                band(ceiling)
              )}
            >
              <span
                className={cn(
                  'flex items-center gap-2 text-[13px] font-semibold',
                  selected ? 'text-foreground' : 'text-foreground/75'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative size-[15px] shrink-0 rounded-full border-[1.5px] transition-colors',
                    selected ? (ceiling === 'full' ? 'border-amber-300' : 'border-primary') : 'border-foreground/30'
                  )}
                >
                  {selected && (
                    <span
                      className={cn(
                        'absolute inset-[2.5px] rounded-full',
                        ceiling === 'full' ? 'bg-amber-300' : 'bg-primary'
                      )}
                    />
                  )}
                </span>
                {t(`ceiling.${ceiling}.title`)}
              </span>
              <span className="pl-[23px] text-xs text-muted-foreground">
                {t(`botSettings.autonomy.option.${ceiling}`)}
              </span>
              <span id={`${id}-${ceiling}`} className="sr-only">
                {[text.lead, text.rest, text.asks?.lead, text.asks?.rest].filter(Boolean).join(' ')}
              </span>
            </button>
          )
        })}
      </div>
      <div aria-hidden="true" className={cn('grid', columns)}>
        {autonomyCapabilities.map((row, rowIndex) => {
          const last = rowIndex === autonomyCapabilities.length - 1
          return [
            <div key={row.id} className="border-t border-border px-2.5 py-2.5 text-[13px] text-foreground/75">
              {t(`botSettings.autonomy.row.${row.id}`)}
            </div>,
            ...ceilingValues.map((ceiling) => (
              <div
                key={`${row.id}-${ceiling}`}
                className={cn(
                  'items-center justify-center border-t border-border transition-colors duration-200 motion-reduce:transition-none',
                  ceiling === value ? 'flex' : 'hidden @xl:flex',
                  band(ceiling),
                  last && 'rounded-b-lg'
                )}
              >
                <Mark
                  allowed={(row.allowed as readonly Ceiling[]).includes(ceiling)}
                  strong={ceiling === value}
                  caution={ceiling === 'full'}
                />
              </div>
            )),
          ]
        })}
      </div>
      <p className="-mx-2 mt-2 flex items-start gap-2.5 border-t border-border px-[18px] pb-3.5 pt-3 text-[13px] text-foreground/75">
        {value === 'full' ? (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
        ) : (
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span>
          <strong className="font-semibold text-foreground">{chosen.lead}</strong> {chosen.rest}
          {chosen.asks && (
            <>
              {' '}
              <strong className="font-semibold text-foreground">{chosen.asks.lead}</strong> {chosen.asks.rest}
            </>
          )}
        </span>
      </p>
    </div>
  )
}
