import { MacImportPicker } from './MacImportPicker'
import { MacImportFlow } from './MacImportDialog'
import {
  emptyImportChoice,
  environmentJoinAvailability,
  hasImportChoice,
  importGroups,
  recommendedImportChoice,
  provisioningAvailability,
  useMacInventory,
  type EnvironmentJoinAvailability,
} from '@/lib/fleet/provisioning'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import {
  creationStepReached,
  creationSteps,
  editEnvironmentName,
  emptyEnvironmentName,
  environmentNameFor,
  followBotName,
  hasEnvironments,
  placementRequest,
  provisioningHintKey,
  type ProvisioningSubject,
} from '@/lib/fleet/environments'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { FLEET_ENVIRONMENT_LIMITS, type FleetBot } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/ui/search-select'
import { choiceClass } from '@/lib/fleet/choice'
import { nextRadioIndex } from '@/lib/fleet/forms'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'
import { BotFields, type BotFieldsValue } from './BotFields'
import { ChoiceMark } from './ChoiceMark'

const placements = ['new', 'existing'] as const

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
  const { t } = useTranslation('fleet')
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
  const [choice, setChoice] = useState(emptyImportChoice)
  const [expanded, setExpanded] = useState(false)
  const [choiceInitialized, setChoiceInitialized] = useState(false)
  const selected = importAllowed && hasImportChoice(choice)
  const [value, setValue] = useState<BotFieldsValue>({ name: '', instructions: '', ceiling: 'auto', talksTo: [] })
  const [created, setCreated] = useState<FleetBot | null>(null)
  const [joined, setJoined] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = created && (fleet.state.snapshot.bots.find((bot) => bot.id === created.id) ?? created)
  const chosen = listed.find((environment) => environment.id === environmentId)
  const chosenAvailability = chosen ? environmentJoinAvailability(fleet, chosen) : null
  const placement = placementRequest(
    where === 'new'
      ? { kind: 'new', name: environmentNameFor(environmentName, value.name) }
      : { kind: 'existing', environmentId },
    environments
  )
  const canSubmit =
    Boolean(value.name.trim()) &&
    !busy &&
    placement !== null &&
    (!environments || where === 'new' || chosenAvailability === 'ready')
  useEffect(() => {
    if (open && expanded && inventory && !choiceInitialized) {
      setChoice(recommendedImportChoice(inventory, importGroups))
      setChoiceInitialized(true)
    }
  }, [open, expanded, inventory, choiceInitialized])
  useEffect(() => {
    if (!open) return
    setWhere(initialEnvironmentId ? 'existing' : 'new')
    setEnvironmentId(initialEnvironmentId)
  }, [open, initialEnvironmentId])
  useEffect(() => {
    if (!open) {
      setValue({ name: '', instructions: '', ceiling: 'auto', talksTo: [] })
      setEnvironmentName(emptyEnvironmentName)
      setCreated(null)
      setJoined(false)
      setChoice(emptyImportChoice())
      setExpanded(false)
      setChoiceInitialized(false)
      setError('')
    }
  }, [open])
  useEffect(() => {
    if (open && !selected && current?.setup.step === 'ready') onCreated(current.id)
  }, [open, selected, current?.id, current?.setup.step, onCreated])
  function joinHint(availability: EnvironmentJoinAvailability): string {
    if (availability === 'full') return t('environment.full', { max: FLEET_ENVIRONMENT_LIMITS.botsMax })
    if (availability === 'update-server') return t('provisioning.updateServer')
    return t('environment.restartToJoin')
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
    if (!canSubmit || !placement) return
    setBusy(true)
    setError('')
    try {
      const bot = await window.api.fleetCreateBot({
        name: value.name.trim(),
        instructions: value.instructions.trim(),
        ceiling: value.ceiling,
        talksTo: value.talksTo,
        ...placement,
      })
      setJoined(environments && where === 'existing')
      setCreated(bot)
      fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot } })
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const steps = creationSteps(joined)
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
          <DialogDescription>
            {created
              ? t('create.progressDescription')
              : environments
                ? t('create.environmentDescription')
                : t('create.description')}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="space-y-3 text-sm">
            {steps.map((step, index) => (
              <div
                key={step}
                className={`flex items-center gap-2 ${creationStepReached(steps, current?.setup.step, index) ? 'text-foreground' : 'text-muted-foreground'}`}
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
            {current?.setup.step === 'ready' &&
              selected &&
              inventory &&
              importSubject &&
              importAvailability === 'ready' && (
                <MacImportFlow
                  key={current.id}
                  subject={importSubject}
                  inventory={inventory}
                  choice={choice}
                  autoStart
                  onDone={() => onCreated(current.id)}
                />
              )}
            {current?.setup.step === 'ready' && selected && importAvailability !== 'ready' && (
              <p className="text-xs text-muted-foreground">
                {t(
                  provisioningHintKey(
                    importAvailability === 'restart-bot' && environments && current.environmentId
                      ? 'restart-environment'
                      : importAvailability
                  )
                )}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t(selected ? 'provisioning.finishLater' : 'create.closeNote')}
            </p>
          </div>
        ) : (
          <>
            <BotFields
              value={value}
              onChange={(next) => {
                setValue(next)
                setEnvironmentName((field) => followBotName(field, next.name))
              }}
              bots={fleet.state.snapshot.bots}
            />
            {environments && (
              <fieldset className="space-y-3">
                <legend className="mb-2 text-sm font-medium">{t('create.where')}</legend>
                <div role="radiogroup" aria-label={t('create.where')} className="grid gap-2 sm:grid-cols-2">
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
                        onClick={() => setWhere(option)}
                        onKeyDown={(event) => onPlacementKey(event, index)}
                        className={cn(
                          'rounded-lg border p-3 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                          choiceClass(where === option)
                        )}
                      >
                        <span className="flex items-start justify-between gap-2">
                          <strong>
                            {option === 'new' ? t('create.newEnvironment') : t('create.existingEnvironment')}
                          </strong>
                          <ChoiceMark selected={where === option} />
                        </span>
                        <span className="mt-1 block text-muted-foreground">
                          {option === 'new'
                            ? t('create.newEnvironmentHint')
                            : disabled
                              ? t('create.noEnvironments')
                              : t('create.existingEnvironmentHint')}
                        </span>
                      </button>
                    )
                  })}
                </div>
                {where === 'new' ? (
                  <label className="block text-sm font-medium">
                    {t('create.environmentName')}
                    <Input
                      className="mt-1 bg-surface-elevated"
                      value={environmentName.value}
                      placeholder={value.name}
                      maxLength={40}
                      onChange={(event) => setEnvironmentName(editEnvironmentName(event.target.value))}
                    />
                  </label>
                ) : (
                  <div className="space-y-2">
                    <span className="block text-sm font-medium">{t('create.environment')}</span>
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
                      onChange={(id) => setEnvironmentId(id ?? null)}
                      placeholder={t('create.chooseEnvironment')}
                      ariaLabel={t('create.environment')}
                    />
                    {chosen && chosenAvailability && chosenAvailability !== 'ready' && (
                      <p className="text-xs text-muted-foreground">{joinHint(chosenAvailability)}</p>
                    )}
                    {chosen && chosenAvailability === 'ready' && (
                      <p className="text-xs text-muted-foreground">
                        {t('create.sharedHint', { environment: chosen.name })}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">{t('environment.sharedNote')}</p>
                  </div>
                )}
              </fieldset>
            )}
            {supportsImport && (!environments || where === 'new') && (
              <div className="space-y-3">
                <Button variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
                  {t('provisioning.fromMac')}
                </Button>
                {expanded && (
                  <>
                    <p className="text-xs text-muted-foreground">{t('provisioning.fromMacHint')}</p>
                    {inventoryError && (
                      <p role="alert" className="text-xs text-destructive">
                        {inventoryError}
                      </p>
                    )}
                    {inventory && choiceInitialized && (
                      <MacImportPicker inventory={inventory} value={choice} onChange={setChoice} />
                    )}
                  </>
                )}
              </div>
            )}
          </>
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
            <Button disabled={!canSubmit} onClick={() => void submit()}>
              {t('create.submit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
