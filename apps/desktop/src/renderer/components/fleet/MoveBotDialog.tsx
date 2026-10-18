import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, Check, CircleCheck, Loader2 } from 'lucide-react'
import { FLEET_NAME_MAX, type FleetBot, type FleetBotMove } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { SearchSelect } from '@/components/ui/search-select'
import { choiceClass } from '@/lib/fleet/choice'
import { editEnvironmentName, emptyEnvironmentName, environmentNameFor } from '@/lib/fleet/environments'
import { fleetErrorText } from '@/lib/fleet/errors'
import { nextRadioIndex } from '@/lib/fleet/forms'
import {
  MOVE_STEPS,
  moveRequest,
  moveStepIndex,
  moveTargetAvailability,
  moveTargetHint,
  type MoveTargetAvailability,
} from '@/lib/fleet/move'
import { botEnvironments, environmentOf } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'
import { ChoiceMark } from './ChoiceMark'

const placements = ['existing', 'new'] as const
const fieldInput =
  'w-full rounded-[9px] border border-input bg-black/25 px-3 py-2 text-sm transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-[invalid=true]:border-destructive'
const takes = ['conversation', 'memory', 'files', 'routines', 'browser'] as const
const stays = ['accounts', 'skills', 'shared'] as const

/** What moves with the bot and what stays with its environment, so the owner knows before confirming. */
function WhatMoves({ from }: { from: string }) {
  const { t } = useTranslation('fleet')
  const list = (kind: 'takes' | 'stays', items: readonly string[], icon: ReactNode) => (
    <div className="px-3 py-2.5">
      <h4 className="mb-1.5 text-[11.5px] font-medium text-muted-foreground">
        {kind === 'takes' ? t('move.takes') : t('move.stays', { environment: from })}
      </h4>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item} className="flex items-center gap-2 text-[12.5px] text-foreground/75">
            {icon}
            {t(`move.${kind}Item.${item}`)}
          </li>
        ))}
      </ul>
    </div>
  )
  return (
    <div className="grid grid-cols-1 divide-y divide-border rounded-[10px] border border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
      {list(
        'takes',
        takes,
        <span
          aria-hidden="true"
          className="flex size-[15px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <Check className="size-[9px]" strokeWidth={3.5} />
        </span>
      )}
      {list(
        'stays',
        stays,
        <span
          aria-hidden="true"
          className="block size-[15px] shrink-0 rounded-full border-[1.5px] border-dashed border-foreground/35"
        />
      )}
    </div>
  )
}

/** The steps of a running move: those done, the one under way and those to come. */
function MoveSteps({ phase }: { phase: FleetBotMove['phase'] }) {
  const { t } = useTranslation('fleet')
  const current = moveStepIndex(phase)
  return (
    <ol className="flex flex-col gap-2" aria-label={t('move.progress')}>
      {MOVE_STEPS.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'active' : 'pending'
        return (
          <li
            key={step}
            aria-current={state === 'active' ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2.5 text-[13px]',
              state === 'pending' ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {state === 'done' ? (
              <span
                aria-hidden="true"
                className="flex size-[18px] items-center justify-center rounded-full bg-primary text-primary-foreground"
              >
                <Check className="size-3" strokeWidth={3} />
              </span>
            ) : state === 'active' ? (
              <Loader2
                aria-hidden="true"
                className="size-[18px] animate-spin text-primary motion-reduce:animate-none"
              />
            ) : (
              <span aria-hidden="true" className="block size-[18px] rounded-full border-[1.5px] border-border-strong" />
            )}
            <span>{t(`move.step.${step}`)}</span>
            <span className="sr-only">
              {', '}
              {t(`move.stepState.${state}`)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Moves a bot to another environment of its server, or to a new one: the owner chooses where and confirms, then
 * follows the move, which goes on on the server if the dialog closes. Dropping a bot on an environment in the sidebar
 * opens it with that environment chosen; nothing moves without the owner's confirmation.
 */
export function MoveBotDialog({
  bot: initial,
  fleet,
  initialEnvironmentId = null,
  onClose,
  onOpenEnvironment,
}: {
  bot: FleetBot
  fleet: FleetController
  /** Chosen already, as when the bot was dropped on an environment. */
  initialEnvironmentId?: string | null
  onClose: () => void
  /** Opens the environment the bot moved to. */
  onOpenEnvironment?: (environmentId: string) => void
}) {
  const { t } = useTranslation('fleet')
  const ids = useId()
  const { environments } = fleet.state.snapshot
  const bot = fleet.state.snapshot.bots.find((item) => item.id === initial.id) ?? initial
  const from = environmentOf(environments, bot)?.name ?? bot.environmentId ?? ''
  const targets = botEnvironments(environments).filter((environment) => environment.id !== bot.environmentId)
  const [where, setWhere] = useState<(typeof placements)[number]>(
    initialEnvironmentId || targets.length ? 'existing' : 'new'
  )
  const [environmentId, setEnvironmentId] = useState<string | null>(initialEnvironmentId)
  const [name, setName] = useState(emptyEnvironmentName)
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [moveId, setMoveId] = useState<string | null>(null)
  const [result, setResult] = useState<FleetBotMove | null>(null)
  const radios = useRef<Array<HTMLButtonElement | null>>([])
  const availability = (id: string): MoveTargetAvailability => {
    const environment = targets.find((item) => item.id === id)
    return environment ? moveTargetAvailability(fleet, bot, environment) : 'current'
  }
  const hint = (value: Exclude<MoveTargetAvailability, 'ready'>) => {
    const { key, values } = moveTargetHint(value)
    return t(key, values)
  }
  const chosen = environmentId ? targets.find((environment) => environment.id === environmentId) : undefined
  const chosenAvailability = environmentId ? availability(environmentId) : null
  const request = moveRequest(
    where === 'new'
      ? { kind: 'new', name: environmentNameFor(name, bot.name) }
      : { kind: 'existing', environmentId: chosenAvailability === 'ready' ? environmentId : null }
  )
  const destination = (move: Pick<FleetBotMove, 'toEnvironmentId'> | null) =>
    move ? (environments.find((environment) => environment.id === move.toEnvironmentId)?.name ?? '') : ''

  // The live move comes with the bot; once it is no longer running, its outcome is read once from the server.
  const live = moveId && bot.move?.id === moveId ? bot.move : null
  useEffect(() => {
    if (!moveId || live || result) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      void window.api
        .fleetGetBotMove(bot.id)
        .then((move) => {
          if (!active) return
          if (move.id === moveId && move.state !== 'running') setResult(move)
          else timer = setTimeout(read, 1000)
        })
        .catch(() => {
          if (active) timer = setTimeout(read, 2000)
        })
    }
    read()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [moveId, live?.id, result, bot.id])

  function onPlacementKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextRadioIndex(index, event.key, placements.length)
    if (next === null) return
    event.preventDefault()
    if (placements[next] === 'existing' && !targets.length) return
    setWhere(placements[next])
    radios.current[next]?.focus()
  }
  async function submit() {
    if (busy) return
    if (!request) {
      setInvalid(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const started = await window.api.fleetMoveBot(bot.id, request)
      setResult(null)
      setMoveId(started.id)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }
  function again() {
    setMoveId(null)
    setResult(null)
  }

  const running = !!moveId && !result
  const movingTo = destination(live ?? result) || (where === 'new' ? environmentNameFor(name, bot.name) : chosen?.name)
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent
        data-testid="move-bot"
        className="flex max-h-[calc(100vh-80px)] max-w-[600px] flex-col gap-0 overflow-hidden p-0 sm:rounded-2xl"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !moveId) {
            event.preventDefault()
            void submit()
          }
        }}
      >
        <div className="shrink-0 px-6 pb-3.5 pt-5">
          <DialogTitle className="pr-8 text-[17px] tracking-[-0.01em]">
            {t('move.title', { name: bot.name })}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[13px]">{t('move.description')}</DialogDescription>
        </div>
        {moveId ? (
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6 pt-1.5">
            {result?.state === 'completed' ? (
              <p role="status" className="flex items-start gap-2.5 text-sm">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-status-ready" aria-hidden="true" />
                {t('move.completed', { name: bot.name, environment: destination(result) })}
              </p>
            ) : result?.state === 'failed' ? (
              <div role="alert" className="flex items-start gap-2.5 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
                <div className="flex flex-col gap-1">
                  <span>{t('move.failed', { name: bot.name, environment: from })}</span>
                  {result.error && (
                    <span className="text-[12.5px] text-muted-foreground">
                      {fleetErrorText(new Error(result.error.message), t)}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <>
                <p role="status" aria-live="polite" className="text-sm">
                  {t('move.running', { name: bot.name, environment: movingTo })}
                </p>
                <MoveSteps phase={live?.phase ?? 'prepared'} />
                <p className="text-xs text-muted-foreground">{t('move.keepsRunning')}</p>
              </>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6 pt-1.5">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-muted-foreground">{t('move.from')}</span>
              <b className="font-medium">{from}</b>
              <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="text-muted-foreground">{movingTo || t('move.toChoose')}</span>
            </div>
            <section aria-labelledby={ids + '-where'} className="flex flex-col gap-3">
              <h3 id={ids + '-where'} className="text-sm font-semibold">
                {t('move.where')}
              </h3>
              <div role="radiogroup" aria-labelledby={ids + '-where'} className="grid gap-2 sm:grid-cols-2">
                {placements.map((option, index) => {
                  const disabled = option === 'existing' && !targets.length
                  return (
                    <button
                      key={option}
                      ref={(node) => {
                        radios.current[index] = node
                      }}
                      type="button"
                      role="radio"
                      aria-checked={where === option}
                      tabIndex={where === option ? 0 : -1}
                      disabled={disabled}
                      onClick={() => {
                        setWhere(option)
                        setInvalid(false)
                      }}
                      onKeyDown={(event) => onPlacementKey(event, index)}
                      className={cn(
                        'flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                        choiceClass(where === option)
                      )}
                    >
                      <span className="mt-px">
                        <ChoiceMark selected={where === option} />
                      </span>
                      <span className="flex min-w-0 flex-col gap-px">
                        <strong className="text-[13px] font-semibold">
                          {option === 'new' ? t('move.newEnvironment') : t('move.existingEnvironment')}
                        </strong>
                        <span className="text-xs text-muted-foreground">
                          {option === 'new'
                            ? t('move.newEnvironmentHint')
                            : disabled
                              ? t('move.noEnvironments')
                              : t('move.existingEnvironmentHint')}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
              {where === 'existing' ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium">{t('move.environment')}</span>
                  <SearchSelect
                    value={environmentId ?? undefined}
                    options={targets.map((environment) => {
                      const state = availability(environment.id)
                      return {
                        id: environment.id,
                        label: environment.name,
                        hint:
                          state === 'ready'
                            ? t('environment.botCount', { count: environment.botIds.length })
                            : hint(state),
                        disabled: state !== 'ready',
                      }
                    })}
                    onChange={(id) => {
                      setEnvironmentId(id ?? null)
                      setInvalid(false)
                    }}
                    placeholder={t('move.chooseEnvironment')}
                    ariaLabel={t('move.environment')}
                    invalid={invalid}
                    avoidOverflow
                    className="[&>button]:h-10 [&>button]:rounded-[9px] [&>button]:bg-black/25 [&>button]:text-sm"
                  />
                  {chosen && chosenAvailability && chosenAvailability !== 'ready' && (
                    <p className="text-xs text-muted-foreground">{hint(chosenAvailability)}</p>
                  )}
                  {invalid && !chosen && (
                    <p className="flex items-center gap-1.5 text-xs text-destructive">
                      <AlertTriangle className="size-3" aria-hidden="true" />
                      {t('move.environmentRequired')}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids + '-name'} className="text-[13px] font-medium">
                    {t('move.environmentName')}
                  </label>
                  <input
                    id={ids + '-name'}
                    className={fieldInput}
                    value={name.value}
                    placeholder={bot.name}
                    maxLength={FLEET_NAME_MAX}
                    autoComplete="off"
                    onChange={(event) => setName(editEnvironmentName(event.target.value))}
                  />
                  <p className="text-xs text-muted-foreground">{t('move.environmentNameHint')}</p>
                </div>
              )}
            </section>
            <WhatMoves from={from} />
            <p className="text-xs text-muted-foreground">{t('move.pauseNote')}</p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border py-3 pl-6 pr-4">
          {!moveId ? (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                {t('move.cancel')}
              </Button>
              <Button disabled={busy} onClick={() => void submit()}>
                {busy && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {t('move.submit')}
              </Button>
            </>
          ) : result?.state === 'failed' ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t('move.close')}
              </Button>
              <Button onClick={again}>{t('move.retry')}</Button>
            </>
          ) : result?.state === 'completed' && onOpenEnvironment ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t('move.close')}
              </Button>
              <Button onClick={() => onOpenEnvironment(result.toEnvironmentId)}>{t('move.openEnvironment')}</Button>
            </>
          ) : (
            <Button variant={running ? 'ghost' : 'default'} onClick={onClose}>
              {t('move.close')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
