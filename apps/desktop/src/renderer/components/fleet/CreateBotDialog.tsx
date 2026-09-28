import { MacImportPicker } from './MacImportPicker'
import {
  emptyImportChoice,
  environmentJoinAvailability,
  environmentJoinHint,
  hasImportChoice,
  importGroups,
  provisioningAvailability,
  useMacInventory,
  type EnvironmentJoinAvailability,
  type ImportChoice,
  type ImportGroup,
} from '@/lib/fleet/provisioning'
import { fleetErrorText } from '@/lib/fleet/errors'
import {
  editEnvironmentName,
  emptyEnvironmentName,
  environmentNameFor,
  followBotName,
  hasEnvironments,
  placementRequest,
  provisioningHintKey,
  type ProvisioningSubject,
} from '@/lib/fleet/environments'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowLeft, Check } from 'lucide-react'
import { FLEET_INSTRUCTIONS_MAX, FLEET_NAME_MAX, type FleetBot } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { SearchSelect } from '@/components/ui/search-select'
import { autonomyAt } from '@/lib/fleet/bot-settings'
import { choiceClass } from '@/lib/fleet/choice'
import { importGroupSize } from '@/lib/fleet/create-bot'
import { ceilingValues, nextRadioIndex, type Ceiling } from '@/lib/fleet/forms'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'
import { BotPeerPicker } from './BotPeerPicker'
import { ChoiceMark } from './ChoiceMark'
import { CreateBotProgress } from './CreateBotProgress'
import { EnvironmentShares, MacImportSummary } from './CreateBotImportSection'

const placements = ['new', 'existing'] as const
const fieldInput =
  'w-full rounded-[9px] border border-input bg-black/25 px-3 py-2 text-sm transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-[invalid=true]:border-destructive'

function Section({
  id,
  title,
  meta,
  note,
  children,
}: {
  id: string
  title: string
  meta?: ReactNode
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="border-t border-border pt-[22px] first:border-t-0 first:pt-0">
      <div className="mb-3">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h3 id={id} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
            {title}
          </h3>
          {meta}
        </div>
        {note && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  )
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-center gap-1.5 text-xs text-destructive">
      <AlertTriangle className="size-3" aria-hidden="true" />
      {children}
    </p>
  )
}

/** How far the new bot goes without asking: three choices, and what the chosen one does alone or asks about. */
function AutonomyChoice({
  value,
  onChange,
  labelledBy,
}: {
  value: Ceiling
  onChange: (value: Ceiling) => void
  labelledBy: string
}) {
  const { t } = useTranslation('fleet')
  const radios = useRef<Array<HTMLButtonElement | null>>([])
  const listsId = useId()
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextRadioIndex(index, event.key, ceilingValues.length)
    if (next === null) return
    event.preventDefault()
    onChange(ceilingValues[next])
    radios.current[next]?.focus()
  }
  const { alone, asks } = autonomyAt(value)
  const full = value === 'full'
  return (
    <div>
      <div role="radiogroup" aria-labelledby={labelledBy} className="grid gap-2 sm:grid-cols-3">
        {ceilingValues.map((ceiling, index) => {
          const selected = value === ceiling
          return (
            <button
              key={ceiling}
              ref={(node) => {
                radios.current[index] = node
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-describedby={listsId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(ceiling)}
              onKeyDown={(event) => onKey(event, index)}
              className={cn(
                'flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected && ceiling === 'full'
                  ? 'border-amber-300/60 bg-amber-300/10 text-foreground'
                  : choiceClass(selected)
              )}
            >
              <span className="mt-px">
                <ChoiceMark selected={selected} />
              </span>
              <span className="flex min-w-0 flex-col gap-px">
                <strong className={cn('text-[13px] font-semibold', selected && ceiling === 'full' && 'text-amber-300')}>
                  {t(`ceiling.${ceiling}.title`)}
                </strong>
                <span className="text-[11.5px] text-muted-foreground">
                  {t(`botSettings.autonomy.option.${ceiling}`)}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <div
        id={listsId}
        className="mt-2.5 grid grid-cols-1 divide-y divide-border rounded-[10px] border border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0"
      >
        {(
          [
            ['alone', alone],
            ['asks', asks],
          ] as const
        ).map(([kind, rows]) => (
          <div key={kind} className="px-3 py-2.5">
            <h4 className="mb-1.5 text-[11.5px] font-medium text-muted-foreground">
              {t(`botSettings.autonomy.${kind}`)}
            </h4>
            <ul className="flex flex-col gap-1">
              {rows.map((row) => (
                <li key={row} className="flex items-center gap-2 text-[12.5px] text-foreground/75">
                  {kind === 'alone' ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-[15px] shrink-0 items-center justify-center rounded-full',
                        full ? 'bg-amber-300 text-amber-950' : 'bg-primary text-primary-foreground'
                      )}
                    >
                      <Check className="size-[9px]" strokeWidth={3.5} />
                    </span>
                  ) : (
                    <span
                      aria-hidden="true"
                      className="block size-[15px] shrink-0 rounded-full border-[1.5px] border-dashed border-foreground/35"
                    />
                  )}
                  {t(`botSettings.autonomy.row.${row}`)}
                </li>
              ))}
              {!rows.length && <li className="text-[12.5px] text-muted-foreground">{t('create.nothingAsks')}</li>}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CreateBotDialog({
  open,
  onClose,
  onCreated,
  fleet,
  initialEnvironmentId = null,
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
  fleet: FleetController
  /** Opened from an environment: the new bot joins it unless the owner picks otherwise. */
  initialEnvironmentId?: string | null
}) {
  const { t, i18n } = useTranslation('fleet')
  const ids = useId()
  const sectionId = (name: string) => `${ids}-${name}`
  // Without the gateway feature the dialog is the one from before environments: every bot gets its own container.
  const environments = hasEnvironments(fleet.state.connection)
  const listed = fleet.state.snapshot.environments
  const supportsImport = fleet.state.connection.features.includes('provisioning')
  const { inventory, error: inventoryError } = useMacInventory(open && supportsImport)
  const [where, setWhere] = useState<(typeof placements)[number]>('new')
  const [environmentName, setEnvironmentName] = useState(emptyEnvironmentName)
  const [environmentId, setEnvironmentId] = useState<string | null>(null)
  const placementRadios = useRef<Array<HTMLButtonElement | null>>([])
  // Accounts and sign-ins from the Mac go to a new environment only: an existing one is already set up.
  const importAllowed = supportsImport && (!environments || where === 'new')
  // Nothing comes from the Mac unless the owner asks: no credential is copied by default.
  const [choice, setChoice] = useState<ImportChoice>(emptyImportChoice)
  const selected = importAllowed && hasImportChoice(choice)
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [ceiling, setCeiling] = useState<Ceiling>('auto')
  const [talksTo, setTalksTo] = useState<string[]>([])
  const [view, setView] = useState<{ kind: 'form' } | { kind: 'picker'; group: ImportGroup }>({ kind: 'form' })
  const [errors, setErrors] = useState<{ name?: boolean; environment?: boolean }>({})
  const [scrolled, setScrolled] = useState(false)
  const [created, setCreated] = useState<FleetBot | null>(null)
  const [joined, setJoined] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const nameInput = useRef<HTMLInputElement>(null)
  const pickerHeading = useRef<HTMLHeadingElement>(null)
  const returnTo = useRef<ImportGroup | null>(null)
  const current = created && (fleet.state.snapshot.bots.find((bot) => bot.id === created.id) ?? created)
  const chosen = listed.find((environment) => environment.id === environmentId)
  const chosenAvailability = chosen ? environmentJoinAvailability(fleet, chosen) : null
  const placement = placementRequest(
    where === 'new'
      ? { kind: 'new', name: environmentNameFor(environmentName, name) }
      : { kind: 'existing', environmentId },
    environments
  )
  useEffect(() => {
    if (!open) return
    setWhere(initialEnvironmentId ? 'existing' : 'new')
    setEnvironmentId(initialEnvironmentId)
  }, [open, initialEnvironmentId])
  useEffect(() => {
    if (!open) {
      setName('')
      setInstructions('')
      setCeiling('auto')
      setTalksTo([])
      setEnvironmentName(emptyEnvironmentName)
      setCreated(null)
      setJoined(false)
      setChoice(emptyImportChoice())
      setView({ kind: 'form' })
      setErrors({})
      setScrolled(false)
      setError('')
    }
  }, [open])
  useEffect(() => {
    if (open && !selected && current?.setup.step === 'ready') onCreated(current.id)
  }, [open, selected, current?.id, current?.setup.step, onCreated])
  // Entering the list of the Mac starts at its heading; leaving it goes back to the row it was opened from.
  useEffect(() => {
    if (view.kind === 'picker') pickerHeading.current?.focus()
    else if (returnTo.current) {
      document.querySelector<HTMLElement>(`[data-choose="${returnTo.current}"]`)?.focus()
      returnTo.current = null
    }
  }, [view.kind])
  function joinHint(availability: Exclude<EnvironmentJoinAvailability, 'ready'>): string {
    const hint = environmentJoinHint(availability)
    return t(hint.key, hint.values)
  }
  function onPlacementKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextRadioIndex(index, event.key, placements.length)
    if (next === null) return
    event.preventDefault()
    if (placements[next] === 'existing' && !listed.length) return
    setWhere(placements[next])
    placementRadios.current[next]?.focus()
  }
  async function submit() {
    if (busy) return
    const problems = {
      name: !name.trim(),
      environment: environments && where === 'existing' && chosenAvailability !== 'ready',
    }
    setErrors(problems)
    if (problems.name) return nameInput.current?.focus()
    if (problems.environment || !placement) {
      const picker = document.getElementById(sectionId('environment'))?.querySelector<HTMLElement>('button')
      picker?.scrollIntoView({ block: 'center' })
      return picker?.focus()
    }
    setBusy(true)
    setError('')
    try {
      const bot = await window.api.fleetCreateBot({
        name: name.trim(),
        instructions: instructions.trim(),
        ceiling,
        talksTo,
        ...placement,
      })
      setJoined(environments && where === 'existing')
      setCreated(bot)
      fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot } })
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }
  // The Mac's accounts go to the new bot's environment, shared by the bots that later join it.
  const importSubject: ProvisioningSubject | null = current
    ? environments && current.environmentId
      ? {
          target: { environmentId: current.environmentId },
          name: listed.find((environment) => environment.id === current.environmentId)?.name ?? current.name,
          running: true,
        }
      : { target: current.id, name: current.name, running: true }
    : null
  const importAvailability = current ? provisioningAvailability(fleet, current) : 'ready'
  const peerTotal = fleet.state.snapshot.bots.length
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' })
  const counted = (group: ImportGroup, count: number) => t(`create.progress.counted.${group}`, { count })
  const takes = importGroups
    .filter((group) => importGroupSize(choice, group))
    .map((group) => counted(group, importGroupSize(choice, group)))
  const summary: ReactNode[] = []
  if (environments) {
    const newName = environmentNameFor(environmentName, name)
    summary.push(
      where === 'new' ? (
        newName ? (
          <>
            {t('create.summary.newEnvironment')} <b className="font-medium text-foreground/75">{newName}</b>
          </>
        ) : (
          t('create.summary.newEnvironment')
        )
      ) : chosen ? (
        <>
          {t('create.summary.existing')} <b className="font-medium text-foreground/75">{chosen.name}</b>
        </>
      ) : (
        t('create.summary.noEnvironment')
      )
    )
  }
  if (importAllowed && takes.length)
    summary.push(
      t(summary.length ? 'create.summary.takes' : 'create.summary.takesFirst', { items: list.format(takes) })
    )
  if (talksTo.length) summary.push(t('create.summary.peers', { count: talksTo.length }))

  const backToForm = () => {
    if (view.kind === 'picker') returnTo.current = view.group
    setView({ kind: 'form' })
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        className="flex h-[min(820px,calc(100vh-80px))] max-w-[640px] flex-col gap-0 overflow-hidden p-0 sm:rounded-2xl"
        onEscapeKeyDown={(event) => {
          // Escape leaves the list of the Mac first, then the dialog.
          if (view.kind !== 'picker') return
          event.preventDefault()
          backToForm()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !created && view.kind === 'form') {
            event.preventDefault()
            void submit()
          }
        }}
      >
        {created && current ? (
          <>
            <DialogTitle className="sr-only">{t('create.title')}</DialogTitle>
            <CreateBotProgress
              key={current.id}
              bot={current}
              joined={joined}
              choice={selected ? choice : null}
              inventory={inventory}
              subject={importSubject}
              importHint={
                importAvailability === 'ready'
                  ? null
                  : t(
                      provisioningHintKey(
                        importAvailability === 'restart-bot' && environments && current.environmentId
                          ? 'restart-environment'
                          : importAvailability
                      )
                    )
              }
              onOpen={() => onCreated(current.id)}
              onClose={onClose}
            />
          </>
        ) : view.kind === 'picker' && inventory ? (
          <div className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 slide-in-from-right-4 duration-200 motion-reduce:animate-none">
            <DialogTitle className="sr-only">{t('create.title')}</DialogTitle>
            <DialogDescription className="sr-only">{t('provisioning.fromMacHint')}</DialogDescription>
            <div className="flex shrink-0 items-center gap-2 px-6 pb-3 pt-4">
              <Button variant="ghost" size="sm" className="-ml-2" onClick={backToForm}>
                <ArrowLeft aria-hidden="true" />
                {t('create.picker.back')}
              </Button>
              <h3 ref={pickerHeading} tabIndex={-1} className="text-[17px] font-semibold focus:outline-none">
                {t('provisioning.fromMac')}
              </h3>
            </div>
            <MacImportPicker inventory={inventory} value={choice} onChange={setChoice} initialGroup={view.group} fill />
            <div className="flex shrink-0 items-center gap-2 border-t border-border py-3 pl-6 pr-4">
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" aria-live="polite">
                {takes.length ? t('create.picker.taking', { items: list.format(takes) }) : t('create.picker.nothing')}
              </p>
              <Button onClick={backToForm}>{t('create.picker.done')}</Button>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col',
              view.kind === 'form' && 'animate-in fade-in-0 duration-150 motion-reduce:animate-none'
            )}
          >
            <div
              className={cn(
                'shrink-0 border-b px-6 pb-3.5 pt-5 transition-colors',
                scrolled ? 'border-border' : 'border-transparent'
              )}
            >
              <DialogTitle className="pr-8 text-[17px] tracking-[-0.01em]">{t('create.title')}</DialogTitle>
              <DialogDescription className="mt-1 text-[13px]">
                {environments ? t('create.environmentDescription') : t('create.description')}
              </DialogDescription>
            </div>
            <div
              className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-6 pb-6 pt-1.5"
              onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 4)}
            >
              <Section id={sectionId('about')} title={t('create.section.about')}>
                <div className="flex flex-col gap-3.5">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <label htmlFor={sectionId('name')} className="text-[13px] font-medium">
                        {t('botFields.name')}
                      </label>
                      <span aria-hidden="true" className="text-[11.5px] tabular-nums text-muted-foreground">
                        {name.length}/{FLEET_NAME_MAX}
                      </span>
                    </div>
                    <input
                      ref={nameInput}
                      id={sectionId('name')}
                      className={fieldInput}
                      value={name}
                      maxLength={FLEET_NAME_MAX}
                      autoComplete="off"
                      autoFocus
                      placeholder={t('create.namePlaceholder')}
                      aria-invalid={!!errors.name}
                      aria-describedby={errors.name ? sectionId('name-error') : undefined}
                      onChange={(event) => {
                        setName(event.target.value)
                        setEnvironmentName((field) => followBotName(field, event.target.value))
                        if (event.target.value.trim()) setErrors((value) => ({ ...value, name: false }))
                      }}
                    />
                    {errors.name && (
                      <FieldError id={sectionId('name-error')}>{t('botSettings.nameRequired')}</FieldError>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <label htmlFor={sectionId('instructions')} className="text-[13px] font-medium">
                        {t('botFields.instructions')}
                      </label>
                      <span aria-hidden="true" className="text-[11.5px] tabular-nums text-muted-foreground">
                        {instructions.length.toLocaleString(i18n.language)}/
                        {FLEET_INSTRUCTIONS_MAX.toLocaleString(i18n.language)}
                      </span>
                    </div>
                    <textarea
                      id={sectionId('instructions')}
                      className={cn(fieldInput, 'min-h-[92px] resize-y leading-relaxed')}
                      value={instructions}
                      maxLength={FLEET_INSTRUCTIONS_MAX}
                      rows={3}
                      placeholder={t('botSettings.instructionsPlaceholder')}
                      aria-describedby={sectionId('instructions-hint')}
                      onChange={(event) => setInstructions(event.target.value)}
                    />
                    <p id={sectionId('instructions-hint')} className="text-xs text-muted-foreground">
                      {t('create.instructionsHint')}
                    </p>
                  </div>
                </div>
              </Section>

              {environments && (
                <Section id={sectionId('where')} title={t('create.where')}>
                  <div role="radiogroup" aria-labelledby={sectionId('where')} className="grid gap-2 sm:grid-cols-2">
                    {placements.map((option, index) => {
                      const disabled = option === 'existing' && !listed.length
                      return (
                        <button
                          key={option}
                          ref={(node) => {
                            placementRadios.current[index] = node
                          }}
                          type="button"
                          role="radio"
                          aria-checked={where === option}
                          tabIndex={where === option ? 0 : -1}
                          disabled={disabled}
                          onClick={() => {
                            setWhere(option)
                            setErrors((value) => ({ ...value, environment: false }))
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
                              {option === 'new' ? t('create.newEnvironment') : t('create.existingEnvironment')}
                            </strong>
                            <span className="text-xs text-muted-foreground">
                              {option === 'new'
                                ? t('create.newEnvironmentHint')
                                : disabled
                                  ? t('create.noEnvironments')
                                  : t('create.existingEnvironmentHint')}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="mt-3">
                    {where === 'new' ? (
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={sectionId('environment-name')} className="text-[13px] font-medium">
                          {t('create.environmentName')}
                        </label>
                        <input
                          id={sectionId('environment-name')}
                          className={fieldInput}
                          value={environmentName.value}
                          placeholder={name || t('create.namePlaceholder')}
                          maxLength={FLEET_NAME_MAX}
                          autoComplete="off"
                          aria-describedby={sectionId('environment-name-hint')}
                          onChange={(event) => setEnvironmentName(editEnvironmentName(event.target.value))}
                        />
                        <p id={sectionId('environment-name-hint')} className="text-xs text-muted-foreground">
                          {t('create.environmentNameHint')}
                        </p>
                      </div>
                    ) : (
                      <div id={sectionId('environment')} className="flex flex-col gap-1.5">
                        <span className="text-[13px] font-medium">{t('create.environment')}</span>
                        <SearchSelect
                          value={environmentId ?? undefined}
                          options={listed.map((environment) => {
                            const availability = environmentJoinAvailability(fleet, environment)
                            return {
                              id: environment.id,
                              label: environment.name,
                              hint:
                                availability === 'ready'
                                  ? t('environment.botCount', { count: environment.botIds.length })
                                  : joinHint(availability),
                              disabled: availability !== 'ready',
                            }
                          })}
                          onChange={(id) => {
                            setEnvironmentId(id ?? null)
                            setErrors((value) => ({ ...value, environment: false }))
                          }}
                          placeholder={t('create.chooseEnvironment')}
                          ariaLabel={t('create.environment')}
                          invalid={!!errors.environment}
                          avoidOverflow
                          className="[&>button]:h-10 [&>button]:rounded-[9px] [&>button]:bg-black/25 [&>button]:text-sm"
                        />
                        {chosen && chosenAvailability && chosenAvailability !== 'ready' && (
                          <p className="text-xs text-muted-foreground">{joinHint(chosenAvailability)}</p>
                        )}
                        {errors.environment && !chosen && (
                          <FieldError id={sectionId('environment-error')}>{t('create.environmentRequired')}</FieldError>
                        )}
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {(importAllowed || (environments && where === 'existing')) && (
                <Section
                  id={sectionId('import')}
                  title={t('create.section.import')}
                  note={
                    importAllowed
                      ? t(environments ? 'create.import.note' : 'create.import.noteBot')
                      : t('environment.sharedNote')
                  }
                >
                  {importAllowed ? (
                    <MacImportSummary
                      inventory={inventory}
                      error={inventoryError}
                      value={choice}
                      onChange={setChoice}
                      onChoose={(group) => setView({ kind: 'picker', group })}
                    />
                  ) : (
                    <EnvironmentShares
                      environment={chosenAvailability === 'ready' ? chosen : undefined}
                      canList={!!chosen && provisioningAvailability(fleet, chosen) === 'ready'}
                    />
                  )}
                </Section>
              )}

              <Section id={sectionId('autonomy')} title={t('botFields.ceiling')} note={t('create.autonomyNote')}>
                <AutonomyChoice value={ceiling} onChange={setCeiling} labelledBy={sectionId('autonomy')} />
              </Section>

              <Section
                id={sectionId('peers')}
                title={t('botSettings.peersHeading')}
                meta={
                  peerTotal > 0 && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t('botSettings.peersCount', { count: talksTo.length, total: peerTotal })}
                    </span>
                  )
                }
                note={t('botFields.talksNote')}
              >
                <BotPeerPicker
                  bots={fleet.state.snapshot.bots}
                  environments={environments ? listed : undefined}
                  value={talksTo}
                  onChange={setTalksTo}
                  labelledBy={sectionId('peers')}
                />
              </Section>

              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t border-border py-3 pl-6 pr-4">
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" aria-live="polite">
                {summary.map((part, index) => (
                  <span key={index}>
                    {index > 0 && ' · '}
                    {part}
                  </span>
                ))}
              </p>
              <Button variant="ghost" onClick={onClose}>
                {t('create.cancel')}
              </Button>
              <Button disabled={busy} onClick={() => void submit()}>
                {t('create.submit')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
