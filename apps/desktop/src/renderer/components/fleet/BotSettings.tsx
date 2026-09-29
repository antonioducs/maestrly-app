import { ApiKeyAccountForm } from './ApiKeyAccountForm'
import { BotAccountsSection } from './BotAccountsSection'
import { BotSkillsMcpSection } from './BotSkillsMcpSection'
import { hasEnvironments } from '@/lib/fleet/environments'
import { environmentOf } from '@/lib/fleet/selectors'
import {
  botProvisioningKey,
  contextLimitAvailability,
  provisioningAvailability,
  useBotProvisioning,
} from '@/lib/fleet/provisioning'
import { fleetErrorMessage, fleetErrorText } from '@/lib/fleet/errors'
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { AlertTriangle, Box, CircleCheck } from 'lucide-react'
import {
  FLEET_INSTRUCTIONS_MAX,
  FLEET_NAME_MAX,
  FLEET_ROLE_MAX,
  FLEET_COMPACTION_LIMITS,
  FLEET_ENVIRONMENT_COMPACTION_FEATURE,
  type FleetBot,
  type FleetSelectionOption,
} from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SearchSelect } from '@/components/ui/search-select'
import { gb } from '@/lib/fleet/format'
import { compactionModelLabel, compactionSourceOf, ENVIRONMENT_COMPACTION_CHOICE } from '@/lib/fleet/compaction'
import {
  botSettingsDraft,
  botSettingsFields,
  botSettingsPatch,
  botSettingsProblems,
  changedBotSettings,
  compactionChange,
  rebaseBotSettingsDraft,
  type BotSettingsDraft,
  type BotSettingsField,
  type BotSettingsProblem,
} from '@/lib/fleet/bot-settings'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'
import { BotAutonomyTable } from './BotAutonomyTable'
import { BotMemorySection } from './BotMemorySection'
import { BotPeerPicker } from './BotPeerPicker'
import { BotRoutinesSection } from './BotRoutinesSection'
import { BotSaveBar, LeaveSettingsDialog } from './BotSaveBar'
import { CompactionFields } from './CompactionFields'
import { SettingsCard, SettingsSection } from './SettingsSection'

/** Asked before the settings are left: runs `proceed` at once, or once the owner saved or discarded their changes. */
export type SettingsLeaveGuard = (proceed: () => void) => void

type SectionId =
  | 'identity'
  | 'autonomy'
  | 'model'
  | 'accounts'
  | 'skills'
  | 'peers'
  | 'routines'
  | 'memory'
  | 'environment'
  | 'where'
  | 'archive'
const domId = (section: SectionId) => `fleet-settings-${section}`
/** Where each field is edited, for the save bar to take the owner there. */
const fieldTargets: Record<BotSettingsField, string> = {
  name: 'fleet-settings-name',
  role: 'fleet-settings-role',
  instructions: 'fleet-settings-instructions',
  ceiling: 'fleet-settings-autonomy-heading',
  selection: 'fleet-settings-model-heading',
  compaction: 'fleet-compaction-heading',
  talksTo: 'fleet-settings-peers-heading',
}
const fieldInput =
  'w-full rounded-[9px] border border-input bg-black/25 px-3 py-2 text-sm transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-[invalid=true]:border-destructive'

function Counter({ length, max }: { length: number; max: number }) {
  const { i18n } = useTranslation('fleet')
  return (
    <span
      aria-hidden="true"
      className={cn('text-[11.5px] tabular-nums text-muted-foreground', length >= max * 0.9 && 'text-amber-300')}
    >
      {length.toLocaleString(i18n.language)}/{max.toLocaleString(i18n.language)}
    </span>
  )
}

function Field({
  id,
  label,
  optional,
  counter,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  optional?: boolean
  counter?: ReactNode
  hint?: ReactNode
  error?: string
  children: ReactNode
}) {
  const { t } = useTranslation('fleet')
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium">
          {label}
          {optional && <span className="ml-1 font-normal text-muted-foreground">{t('botSettings.optional')}</span>}
        </label>
        {counter}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3" aria-hidden="true" />
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

export function BotSettings({
  bot,
  fleet,
  onArchived,
  onOpenScreen,
  onOpenEnvironment,
  leaveGuard,
}: {
  bot: FleetBot
  fleet: FleetController
  onArchived: () => void
  onOpenScreen: () => void
  onOpenEnvironment?: () => void
  /** Set while the settings are open, for the view around them to ask before leaving. */
  leaveGuard?: MutableRefObject<SettingsLeaveGuard | null>
}) {
  const { t, i18n } = useTranslation('fleet')
  // With environments, accounts, skills, MCP servers and resources belong to the bot's environment and are managed
  // there; without them, a bot keeps every section it had.
  const environments = hasEnvironments(fleet.state.connection) ? fleet.state.snapshot.environments : undefined
  const shared = environments !== undefined && bot.environmentId !== null
  const environment = shared ? environmentOf(fleet.state.snapshot.environments, bot) : undefined
  // The last bot of an environment leaves it running, empty, until the owner stops or archives it.
  const lastInEnvironment = environment?.botIds.every((id) => id === bot.id) ?? false
  const availability = provisioningAvailability(fleet, bot)
  const provisioning = useBotProvisioning(bot.id, !shared && availability === 'ready' && bot.lifecycle === 'running')
  const provisioningKey = botProvisioningKey(bot)
  useEffect(() => {
    provisioning.refresh()
  }, [provisioningKey, provisioning.refresh])
  // With environment defaults, a bot without a model of its own shows its environment's default as its choice.
  const inheritable = shared && fleet.state.connection.features.includes(FLEET_ENVIRONMENT_COMPACTION_FEATURE)
  // The Maestrly that applies the limit is the environment's when it is listed, else the bot's own.
  const contextLimit = contextLimitAvailability(fleet, environment ?? bot)

  const base = botSettingsDraft(bot, inheritable)
  const baseKey = JSON.stringify(base)
  const previousBase = useRef(base)
  const [draft, setDraft] = useState<BotSettingsDraft>(base)
  // The bot changed elsewhere: fields the owner has not touched follow it.
  useEffect(() => {
    const previous = previousBase.current
    previousBase.current = base
    setDraft((current) => rebaseBotSettingsDraft(current, previous, base))
  }, [baseKey])
  const [options, setOptions] = useState<FleetSelectionOption[]>([])
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [justSaved, setJustSaved] = useState(false)
  const [nameTouched, setNameTouched] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [error, setError] = useState('')
  const [screenBusy, setScreenBusy] = useState(false)
  const [screenError, setScreenError] = useState('')
  const scrollRef = useRef<HTMLElement>(null)
  const compactionRef = useRef<HTMLElement>(null)
  const needsCompaction = bot.activity?.kind === 'setup' && bot.activity.need === 'compaction'

  const changed = changedBotSettings(bot, draft, inheritable)
  const problems = botSettingsProblems(bot, draft, inheritable)
  const compaction = compactionChange(bot, draft.compaction, inheritable)
  const edit = (patch: Partial<BotSettingsDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setJustSaved(false)
    setSaveError('')
  }

  // The section sits below the main form; a bot blocked on it opens scrolled straight to the fix, once per bot so a
  // status update never yanks the owner's scroll.
  useEffect(() => {
    if (needsCompaction) compactionRef.current?.scrollIntoView({ block: 'start' })
  }, [bot.id])
  useEffect(() => {
    let alive = true
    void window.api
      .fleetListSelections(bot.id)
      .then((models) => {
        if (alive) setOptions(models.options)
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [bot.id])

  const environmentCompaction =
    environment?.compaction ?? (compactionSourceOf(bot) === 'environment' ? bot.compaction : null)
  // A bot with a model of its own is not offered a default its environment does not have: it would be left without.
  const compactionLeading =
    inheritable && (environmentCompaction || compactionSourceOf(bot) !== 'bot')
      ? {
          id: ENVIRONMENT_COMPACTION_CHOICE,
          label: environmentCompaction
            ? t('botSettings.compaction.environmentDefault', {
                model: compactionModelLabel(environmentCompaction, options),
              })
            : t('botSettings.compaction.environmentDefaultUnset'),
        }
      : undefined
  const compactionProblem = bot.compactionState?.problem
    ? t(`botSettings.compaction.problem.${bot.compactionState.problem}`, {
        // A gone model has no option left: name its account by label, never by its internal id.
        model: bot.compaction
          ? `${
              options.find((option) => option.providerId === bot.compaction?.providerId)?.providerLabel ??
              bot.accounts.providers.find((provider) => provider.id === bot.compaction?.providerId)?.label ??
              t('botSettings.compaction.removedAccount')
            } · ${bot.compaction.modelId}`
          : '',
      })
    : ''

  async function save(): Promise<boolean> {
    if (busy) return false
    if (!changed.length) return true
    if (problems.length) {
      setShowErrors(true)
      return false
    }
    setBusy(true)
    setSaveError('')
    try {
      const updated = await window.api.fleetUpdateBot(bot.id, botSettingsPatch(bot, draft, inheritable, options))
      fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot: updated } })
      setDraft(botSettingsDraft(updated, inheritable))
      setNameTouched(false)
      setShowErrors(false)
      setJustSaved(true)
      return true
    } catch (cause) {
      setSaveError(fleetErrorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }
  function discard() {
    setDraft(botSettingsDraft(bot, inheritable))
    setSaveError('')
    setNameTouched(false)
    setShowErrors(false)
  }

  // The view around asks before leaving with unsaved changes (its own tabs, and the screen and environment these
  // settings open); the latest state answers, without re-registering.
  const pending = useRef({ changed, leave: (proceed: () => void) => proceed() })
  pending.current.changed = changed
  pending.current.leave = (proceed) => (pending.current.changed.length ? setLeaving(() => proceed) : proceed())
  useEffect(() => {
    if (!leaveGuard) return
    const guard: SettingsLeaveGuard = (proceed) => pending.current.leave(proceed)
    leaveGuard.current = guard
    return () => {
      if (leaveGuard.current === guard) leaveGuard.current = null
    }
  }, [leaveGuard])
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 's') return
      // A dialog on top (a routine, a confirmation) owns the keyboard.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      void saveRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  async function refreshBot() {
    const updated = await window.api.fleetGetBot(bot.id)
    fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot: updated } })
    const models = await window.api.fleetListSelections(bot.id)
    setOptions(models.options)
  }
  async function logInOnScreen() {
    setScreenBusy(true)
    setScreenError('')
    try {
      if (bot.takeover.state !== 'human') await window.api.fleetTakeover(bot.id)
      await window.api.fleetUiOpen(bot.id, { target: 'accounts' })
      onOpenScreen()
    } catch {
      setScreenError(t('botSettings.screenLoginFailed'))
    } finally {
      setScreenBusy(false)
    }
  }
  async function archive() {
    setArchiveBusy(true)
    setError('')
    try {
      const archived = await window.api.fleetBotAction(bot.id, 'archive')
      if (archived)
        fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot: archived } })
      onArchived()
      setArchiving(false)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setArchiveBusy(false)
    }
  }

  // ---- Side navigation: the section in view, and each section's pending changes or problem. ----
  const sections: SectionId[] = [
    'identity',
    'autonomy',
    'model',
    ...(shared ? [] : (['accounts', 'skills'] as const)),
    'peers',
    'routines',
    'memory',
    shared ? 'environment' : 'where',
    'archive',
  ]
  const [active, setActive] = useState<SectionId>('identity')
  const spyLock = useRef(0)
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    let frame = 0
    const update = () => {
      if (Date.now() < spyLock.current) return
      const line = root.getBoundingClientRect().top + 110
      let current = sections[0]
      for (const section of sections) {
        const element = document.getElementById(domId(section))
        if (element && element.getBoundingClientRect().top <= line) current = section
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = sections[sections.length - 1]
      setActive(current)
    }
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [sections.join()])
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  /** Scrolls to a section (or a field's target inside it) and moves the focus there. */
  function goTo(section: SectionId, targetId?: string) {
    const element = document.getElementById(domId(section))
    if (!element) return
    spyLock.current = Date.now() + 800
    setActive(section)
    const target = (targetId && document.getElementById(targetId)) || element
    target.scrollIntoView({ block: targetId ? 'center' : 'start', behavior: reducedMotion() ? 'auto' : 'smooth' })
    const focusable = targetId ? target : (element.querySelector<HTMLElement>('[tabindex="-1"]') ?? element)
    focusable.focus({ preventScroll: true })
  }
  const dirtySections = new Set<string>(
    changed.map((field) => botSettingsFields.find((item) => item.id === field)?.section ?? '')
  )
  const attention = (section: SectionId) => section === 'model' && !!bot.compactionState?.problem

  // ---- Field problems: the name once it was left or a save was tried, the rest at once. ----
  const problemText = (problem: BotSettingsProblem) =>
    problem === 'name'
      ? t('botSettings.nameRequired')
      : problem === 'role'
        ? t('botSettings.roleTooLong', { max: FLEET_ROLE_MAX })
        : problem === 'compactionModel'
          ? t('botSettings.compactionModelRequired')
          : problem === 'compactionContextLimit'
            ? t('botSettings.compaction.contextLimitInvalid', {
                min: FLEET_COMPACTION_LIMITS.contextLimitTokensMin / 1_000,
                max: FLEET_COMPACTION_LIMITS.contextLimitTokensMax / 1_000,
              })
            : t('botSettings.compaction.intervalInvalid')
  const nameError = problems.includes('name') && (nameTouched || showErrors) ? problemText('name') : ''
  const roleError = problems.includes('role') ? problemText('role') : ''
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' })
  const blocking =
    problems.length === 1
      ? t('botSettings.saveBar.fixOne', { problem: problemText(problems[0]) })
      : problems.length > 1
        ? t('botSettings.saveBar.fixMany', {
            count: problems.length,
            fields: list.format(problems.map((problem) => t(`botSettings.problemField.${problem}`))),
          })
        : ''

  const navLabel = (section: SectionId) => t(`botSettings.section.${section}`)
  const peerCount = fleet.state.snapshot.bots.filter((item) => item.id !== bot.id).length
  return (
    <section ref={scrollRef} className="@container min-h-0 flex-1 overflow-y-auto">
      {/* Narrow, a block: the navigation stays on top as the page scrolls, which a grid row of its own would stop. */}
      <div className="mx-auto block max-w-[1000px] px-4 @5xl:grid @5xl:grid-cols-[176px_minmax(0,720px)] @5xl:justify-center @5xl:gap-12 @5xl:px-8 @5xl:pt-7">
        <nav
          aria-label={t('botSettings.nav')}
          className="sticky top-0 z-20 -mx-4 overflow-x-auto border-b border-border bg-surface px-4 py-2 backdrop-blur-xl [scrollbar-width:none] @5xl:top-7 @5xl:mx-0 @5xl:self-start @5xl:overflow-visible @5xl:border-0 @5xl:bg-transparent @5xl:p-0 @5xl:backdrop-blur-none"
        >
          <ul className="flex gap-px @5xl:flex-col">
            {sections.map((section) => {
              const current = section === active
              const flagged = attention(section)
              const dirty = dirtySections.has(section)
              return (
                <li key={section}>
                  <a
                    href={`#${domId(section)}`}
                    aria-current={current ? 'location' : undefined}
                    onClick={(event) => {
                      event.preventDefault()
                      goTo(section)
                    }}
                    className={cn(
                      'flex items-center justify-between gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      current
                        ? 'bg-foreground/[0.07] text-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <span>{navLabel(section)}</span>
                    {flagged ? (
                      <>
                        <AlertTriangle className="size-3 text-amber-300" aria-hidden="true" />
                        <span className="sr-only">, {t('botSettings.sectionAttention')}</span>
                      </>
                    ) : (
                      dirty && (
                        <>
                          <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                          <span className="sr-only">, {t('botSettings.sectionDirty')}</span>
                        </>
                      )
                    )}
                  </a>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-col gap-10 pb-10 pt-4 @5xl:pt-0 [&_section]:scroll-mt-16 @5xl:[&_section]:scroll-mt-5">
          {compactionProblem && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300/35 bg-amber-300/10 px-3.5 py-3"
            >
              <AlertTriangle className="size-4 shrink-0 text-amber-300" aria-hidden="true" />
              <div className="flex min-w-56 flex-1 flex-col text-[13px]">
                <strong className="font-semibold">{t('botSettings.problemTitle', { name: bot.name })}</strong>
                <span className="text-foreground/75">{compactionProblem}</span>
              </div>
              <Button size="sm" variant="outline" onClick={() => goTo('model', 'fleet-compaction-heading')}>
                {t('botSettings.chooseModel')}
              </Button>
            </div>
          )}

          <SettingsSection id={domId('identity')} title={navLabel('identity')} note={t('botSettings.identityNote')}>
            <SettingsCard className="flex flex-col gap-4 p-[18px]">
              <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
                <Field
                  id="fleet-settings-name"
                  label={t('botFields.name')}
                  counter={<Counter length={draft.name.length} max={FLEET_NAME_MAX} />}
                  error={nameError}
                >
                  <input
                    id="fleet-settings-name"
                    className={fieldInput}
                    value={draft.name}
                    maxLength={FLEET_NAME_MAX}
                    autoComplete="off"
                    aria-invalid={!!nameError}
                    aria-describedby={nameError ? 'fleet-settings-name-error' : undefined}
                    onChange={(event) => edit({ name: event.target.value })}
                    onBlur={() => setNameTouched(true)}
                  />
                </Field>
                <Field
                  id="fleet-settings-role"
                  label={t('botFields.role')}
                  optional
                  counter={<Counter length={draft.role.length} max={FLEET_ROLE_MAX} />}
                  error={roleError}
                >
                  <input
                    id="fleet-settings-role"
                    className={fieldInput}
                    value={draft.role}
                    maxLength={FLEET_ROLE_MAX}
                    autoComplete="off"
                    placeholder={t('botSettings.rolePlaceholder')}
                    aria-invalid={!!roleError}
                    onChange={(event) => edit({ role: event.target.value })}
                  />
                </Field>
              </div>
              <Field
                id="fleet-settings-instructions"
                label={t('botFields.instructions')}
                counter={<Counter length={draft.instructions.length} max={FLEET_INSTRUCTIONS_MAX} />}
                hint={t('botSettings.instructionsHint')}
              >
                <textarea
                  id="fleet-settings-instructions"
                  className={cn(fieldInput, 'min-h-[124px] resize-y leading-relaxed')}
                  value={draft.instructions}
                  maxLength={FLEET_INSTRUCTIONS_MAX}
                  rows={5}
                  placeholder={t('botSettings.instructionsPlaceholder')}
                  aria-describedby="fleet-settings-instructions-hint"
                  onChange={(event) => edit({ instructions: event.target.value })}
                />
              </Field>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection id={domId('autonomy')} title={navLabel('autonomy')} note={t('botSettings.autonomyNote')}>
            <BotAutonomyTable
              value={draft.ceiling}
              onChange={(ceiling) => edit({ ceiling })}
              labelledBy="fleet-settings-autonomy-heading"
            />
          </SettingsSection>

          <SettingsSection
            id={domId('model')}
            title={navLabel('model')}
            note={
              shared ? (
                <Trans
                  i18nKey="botSettings.modelFromEnvironment"
                  t={t}
                  values={{ name: environment?.name ?? bot.environmentId }}
                  components={{
                    link: (
                      <button
                        type="button"
                        className="text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onOpenEnvironment?.()}
                      />
                    ),
                  }}
                />
              ) : (
                t('botSettings.modelFromBot')
              )
            }
          >
            <SettingsCard>
              <div className="flex flex-col gap-1.5 p-[18px]">
                <span id="fleet-settings-main-model" className="text-[13px] font-medium">
                  {t('botSettings.mainModel')}
                </span>
                <SearchSelect
                  value={draft.selectionId || undefined}
                  options={options.map((option) => ({
                    id: option.id,
                    label: `${option.providerLabel} · ${option.modelLabel}`,
                  }))}
                  onChange={(id) => edit({ selectionId: id ?? '' })}
                  disabled={!options.length}
                  placeholder={t('botSettings.chooseModel')}
                  ariaLabel={t('botSettings.mainModel')}
                />
                <p className="text-xs text-muted-foreground">
                  {options.length ? t('botSettings.mainModelHint') : t('botSettings.noAccount')}
                </p>
              </div>
              <div className="h-px bg-border" />
              <section
                ref={compactionRef}
                aria-labelledby="fleet-compaction-heading"
                className="flex flex-col gap-4 p-[18px]"
              >
                <div>
                  <h3 id="fleet-compaction-heading" tabIndex={-1} className="text-sm font-semibold focus:outline-none">
                    {t('botSettings.compaction.heading')}
                  </h3>
                  <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                    {t('botSettings.compaction.description')}
                  </p>
                </div>
                {compactionProblem && (
                  <p className="flex items-center gap-1.5 text-xs text-amber-300">
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    {compactionProblem}
                  </p>
                )}
                <CompactionFields
                  form={draft.compaction}
                  onChange={(form) => edit({ compaction: form })}
                  options={options}
                  idPrefix="fleet-compaction"
                  leading={compactionLeading}
                  dense
                  contextLimit={contextLimit === 'unsupported' ? undefined : contextLimit}
                />
                {compaction.inherits && (
                  <p className="text-xs text-muted-foreground">
                    {t('botSettings.compaction.inheritNote')}{' '}
                    {onOpenEnvironment && (
                      <button
                        type="button"
                        className="text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={onOpenEnvironment}
                      >
                        {t('botSettings.compaction.editEnvironmentDefault')}
                      </button>
                    )}
                  </p>
                )}
                {inheritable &&
                  !compaction.inherits &&
                  compaction.dirty &&
                  draft.compaction.modelId &&
                  !environmentCompaction && (
                    <p className="text-xs text-muted-foreground">
                      {t('botSettings.compaction.becomesDefault', {
                        environment: environment?.name ?? bot.environmentId,
                      })}
                    </p>
                  )}
              </section>
            </SettingsCard>
          </SettingsSection>

          {!shared && (
            <>
              <div id={domId('accounts')} tabIndex={-1} className="scroll-mt-16 focus:outline-none @5xl:scroll-mt-5">
                <BotAccountsSection
                  key={bot.id}
                  subject={{ target: bot.id, name: bot.name, running: bot.lifecycle === 'running' }}
                  lists={provisioning}
                  availability={availability}
                  onChanged={refreshBot}
                >
                  <ApiKeyAccountForm target={bot.id} onAdded={refreshBot} />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={screenBusy || bot.lifecycle !== 'running'}
                    onClick={() => void logInOnScreen()}
                  >
                    {t('botSettings.loginOnScreen')}
                  </Button>
                  {screenError && (
                    <p role="alert" className="text-xs text-destructive">
                      {screenError}
                    </p>
                  )}
                </BotAccountsSection>
              </div>
              <div id={domId('skills')} tabIndex={-1} className="scroll-mt-16 focus:outline-none @5xl:scroll-mt-5">
                <BotSkillsMcpSection
                  key={bot.id}
                  subject={{ target: bot.id, name: bot.name, running: bot.lifecycle === 'running' }}
                  lists={provisioning}
                  availability={availability}
                />
              </div>
            </>
          )}

          <SettingsSection
            id={domId('peers')}
            title={t('botSettings.peersHeading')}
            note={t('botFields.talksNote')}
            aside={
              peerCount > 0 && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t('botSettings.peersCount', { count: draft.talksTo.length, total: peerCount })}
                </span>
              )
            }
          >
            <BotPeerPicker
              bots={fleet.state.snapshot.bots}
              selfId={bot.id}
              environments={environments}
              value={draft.talksTo}
              onChange={(talksTo) => edit({ talksTo })}
              labelledBy="fleet-settings-peers-heading"
            />
          </SettingsSection>

          <BotRoutinesSection key={`routines-${bot.id}`} id={domId('routines')} bot={bot} fleet={fleet} />
          <BotMemorySection key={`memory-${bot.id}`} id={domId('memory')} bot={bot} />

          {shared ? (
            <SettingsSection id={domId('environment')} title={t('environment.label')} note={t('environment.linkNote')}>
              <SettingsCard className="flex flex-col gap-3 p-[18px]">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-9 items-center justify-center rounded-[10px] bg-foreground/5 text-foreground/75"
                  >
                    <Box className="size-4" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      {environment?.name ?? bot.environmentId}
                      {environment && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                          <span
                            aria-hidden="true"
                            className={cn(
                              'size-1.5 rounded-full',
                              environment.lifecycle === 'running' ? 'bg-status-ready' : 'bg-muted-foreground/70'
                            )}
                          />
                          {t(`environment.lifecycle.${environment.lifecycle}`)}
                        </span>
                      )}
                    </div>
                    {environment && (
                      <span className="text-xs text-muted-foreground">
                        {t('botSettings.environmentBots', {
                          count: environment.botIds.length,
                          names: list.format(
                            environment.botIds.map(
                              (id) => fleet.state.snapshot.bots.find((item) => item.id === id)?.name ?? id
                            )
                          ),
                        })}
                      </span>
                    )}
                  </div>
                  {onOpenEnvironment && (
                    <Button size="sm" variant="outline" onClick={onOpenEnvironment}>
                      {t('botSettings.openEnvironment')}
                    </Button>
                  )}
                </div>
                {inheritable && (
                  <p className="text-[12.5px] text-muted-foreground">
                    {environmentCompaction
                      ? t('botSettings.environmentCompaction', {
                          model: compactionModelLabel(environmentCompaction, options),
                        })
                      : t('botSettings.environmentCompactionUnset')}
                  </p>
                )}
              </SettingsCard>
            </SettingsSection>
          ) : (
            <SettingsSection id={domId('where')} title={t('botSettings.where')}>
              <SettingsCard className="p-[18px] text-sm">
                {t('botSettings.container')} <code>maestrly-bot-{bot.id}</code> · {t('server.memory')}{' '}
                {bot.resources.memoryBytes === null ? '—' : `${gb(bot.resources.memoryBytes)} GB`} · {t('server.cpu')}{' '}
                {bot.resources.cpuPercent === null ? '—' : `${Math.round(bot.resources.cpuPercent)}%`} ·{' '}
                {t('botSettings.started')}{' '}
                {bot.resources.startedAt ? new Date(bot.resources.startedAt).toLocaleString(i18n.language) : '—'}
              </SettingsCard>
            </SettingsSection>
          )}

          <SettingsSection id={domId('archive')} title={navLabel('archive')}>
            <SettingsCard className="flex flex-wrap items-center justify-between gap-3 border-destructive/30 p-[18px]">
              <p className="min-w-64 flex-1 text-[12.5px] text-muted-foreground">
                {shared
                  ? lastInEnvironment
                    ? t('botSettings.archiveLastNote')
                    : t('botSettings.archiveOnlyNote')
                  : t('botSettings.archiveNote')}
              </p>
              <Button
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setArchiving(true)}
              >
                {t('botSettings.archive', { name: bot.name })}
              </Button>
            </SettingsCard>
          </SettingsSection>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {changed.length > 0 || saveError ? (
            <BotSaveBar
              changed={changed}
              blocking={blocking}
              error={saveError}
              busy={busy}
              onSave={() => void save()}
              onDiscard={discard}
              onGoTo={(field) =>
                goTo(botSettingsFields.find((item) => item.id === field)?.section ?? 'identity', fieldTargets[field])
              }
            />
          ) : (
            justSaved && (
              <div className="pointer-events-none sticky bottom-4 z-10 mt-2 flex justify-center">
                <p
                  role="status"
                  className="flex items-center gap-2 rounded-[11px] border border-border-strong bg-popover px-3.5 py-2 text-[13px] shadow-lg animate-in fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none"
                >
                  <CircleCheck className="size-4 text-status-ready" aria-hidden="true" />
                  {t('botSettings.saved')}
                </p>
              </div>
            )
          )}
        </div>
      </div>
      {leaving && (
        <LeaveSettingsDialog
          botName={bot.name}
          changed={changed}
          busy={busy}
          blocked={problems.length > 0}
          onKeep={() => setLeaving(null)}
          onDiscard={() => {
            const proceed = leaving
            discard()
            setLeaving(null)
            proceed()
          }}
          onSave={() => {
            const proceed = leaving
            void save().then((ok) => {
              if (!ok) return
              setLeaving(null)
              proceed()
            })
          }}
        />
      )}
      {archiving && (
        <ConfirmDialog
          title={t('botSettings.archiveTitle')}
          message={t(
            shared
              ? lastInEnvironment
                ? 'botSettings.archiveLastConfirm'
                : 'botSettings.archiveOnlyConfirm'
              : 'botSettings.archiveConfirm'
          )}
          confirmLabel={t('botSettings.archiveConfirmButton')}
          destructive
          busy={archiveBusy}
          onCancel={() => setArchiving(false)}
          onConfirm={() => void archive()}
        />
      )}
    </section>
  )
}
