import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, CircleCheck, X } from 'lucide-react'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import type { MacImportReport, MacInventory } from '../../../shared/fleet-provisioning'
import { Button } from '@/components/ui/button'
import { DialogDescription } from '@/components/ui/dialog'
import { failedImportChoice, importReportSummary, mergeImportReport, reportGroups } from '@/lib/fleet/create-bot'
import { creationSteps, finishLaterKey, type ProvisioningSubject } from '@/lib/fleet/environments'
import { fleetErrorMessage, fleetErrorText } from '@/lib/fleet/errors'
import { hasImportChoice, importGroups, provisioningErrorText, type ImportChoice } from '@/lib/fleet/provisioning'
import { cn } from '@/lib/utils'
import { BotLoginCard, type LoginCardStage } from './BotLoginCard'

type ImportState =
  | { kind: 'waiting' }
  | { kind: 'sending'; retry: number | null }
  | { kind: 'done'; report: MacImportReport }
  | { kind: 'error'; message: string }

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 shrink-0 animate-spin rounded-full border-2 border-foreground/15 border-t-foreground motion-reduce:animate-none"
    />
  )
}
const box = 'overflow-hidden rounded-xl border border-border bg-foreground/[0.025]'
const copyCount = (choice: ImportChoice) =>
  choice.apiKeyIds.length + choice.copyIds.length + choice.skillNames.length + choice.mcpServerIds.length

/**
 * A bot being created: its setup steps, then what it brings from this Mac (sent once it is ready, with the failures
 * sent again on request) and the subscriptions to sign in to, one at a time.
 */
export function CreateBotProgress({
  bot,
  joined,
  choice,
  inventory,
  subject,
  importHint,
  onOpen,
  onClose,
}: {
  bot: FleetBot
  joined: boolean
  /** What to bring from this Mac, when anything. */
  choice: ImportChoice | null
  inventory: MacInventory | null
  /** Where it goes: the new environment, or the bot before environments. */
  subject: ProvisioningSubject | null
  /** Why the destination cannot take it yet, when it cannot. */
  importHint: string | null
  onOpen: () => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const steps = creationSteps(joined)
  const ready = bot.setup.step === 'ready'
  const failed = bot.setup.step === 'failed'
  const current = steps.indexOf(bot.setup.step)
  const toCopy = choice && hasImportChoice({ ...choice, loginIds: [] }) ? choice : null
  const canSend = ready && !!subject && !importHint
  const [state, setState] = useState<ImportState>({ kind: 'waiting' })
  const started = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function send(selection: ImportChoice, previous: MacImportReport | null) {
    if (!subject) return
    setState({ kind: 'sending', retry: previous ? copyCount(selection) : null })
    try {
      const { loginIds: _logins, ...request } = selection
      const report = await window.api.fleetImportFromMac(subject.target, request)
      if (alive.current) setState({ kind: 'done', report: previous ? mergeImportReport(previous, report) : report })
    } catch (cause) {
      if (alive.current) setState({ kind: 'error', message: fleetErrorMessage(cause) })
    }
  }
  useEffect(() => {
    if (!toCopy || !canSend || started.current) return
    started.current = true
    void send(toCopy, null)
  }, [Boolean(toCopy), canSend])

  const logins = inventory?.logins.filter((item) => choice?.loginIds.includes(item.id)) ?? []
  const [stages, setStages] = useState<Record<string, { stage: LoginCardStage; account: string | null }>>({})
  const stageOf = (id: string) => stages[id]?.stage ?? 'todo'
  const setStage = (id: string, stage: LoginCardStage, account: string | null = null) =>
    setStages((value) => ({ ...value, [id]: { stage, account } }))
  const running = logins.find((item) => stageOf(item.id) === 'active')
  const nextLogin = logins.find((item) => stageOf(item.id) === 'todo')

  const summary = state.kind === 'done' ? importReportSummary(state.report) : null
  const pending =
    logins.some((item) => stageOf(item.id) !== 'done') || !!summary?.failed.length || state.kind === 'error'
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' })
  const counted = (group: (typeof importGroups)[number], count: number) =>
    t(`create.progress.counted.${group}`, { count })

  return (
    <>
      <div className="flex shrink-0 items-start gap-3 px-6 pb-3.5 pt-5">
        <div className="min-w-0 flex-1 pr-6">
          <h3 className="text-[17px] font-semibold tracking-[-0.01em]" aria-live="polite">
            {failed
              ? t('create.progress.failedTitle', { name: bot.name })
              : ready
                ? t('create.progress.readyTitle', { name: bot.name })
                : t('create.progress.title', { name: bot.name })}
          </h3>
          <DialogDescription className="mt-0.5 text-[13px]">
            {failed
              ? t('create.progress.failedDescription')
              : ready
                ? t('create.progress.readyDescription')
                : t('create.progressDescription')}
          </DialogDescription>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-6 pb-6 pt-1">
        <ol aria-label={t('create.progress.steps')} className={`${box} px-3.5 py-1.5`}>
          {steps.map((step, index) => {
            const done = ready || current > index
            const now = !ready && !failed && index === current
            return (
              <li
                key={step}
                className={cn(
                  'flex items-center gap-2.5 py-2 text-[13px]',
                  index > 0 && 'border-t border-border',
                  done || now ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-[18px] shrink-0 items-center justify-center rounded-full',
                    done ? 'bg-status-ready text-primary-foreground' : !now && 'border-[1.5px] border-foreground/20'
                  )}
                >
                  {done ? <Check className="size-[11px]" strokeWidth={3} /> : now ? <Spinner /> : null}
                </span>
                {t(`create.step.${step}`)}
                <span className="sr-only">
                  ,{' '}
                  {t(done ? 'create.progress.stepDone' : now ? 'create.progress.stepNow' : 'create.progress.stepTodo')}
                </span>
              </li>
            )
          })}
        </ol>

        {failed && (
          <p
            role="alert"
            className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/[0.08] px-3.5 py-3 text-[13px]"
          >
            <X className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            {bot.setup.errorMessage ? fleetErrorText(bot.setup.errorMessage, t) : t('create.failed')}
          </p>
        )}

        {toCopy && !failed && (
          <section aria-labelledby="create-progress-copied">
            <h4 id="create-progress-copied" className="mb-2 text-[13px] font-semibold">
              {t('create.progress.fromMac')}
            </h4>
            <div className={box}>
              {state.kind === 'waiting' && (
                <div className="px-3.5 py-2.5 text-[13px]">
                  {importHint ?? t('create.progress.waitReady')}
                  <span className="block text-xs text-muted-foreground">
                    {t('create.progress.toCopy', { count: copyCount(toCopy) })}
                  </span>
                </div>
              )}
              {state.kind === 'sending' && (
                <div role="status" className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px]">
                  <Spinner />
                  {state.retry === null
                    ? t('create.progress.copying', { count: copyCount(toCopy) })
                    : t('create.progress.retrying', { count: state.retry })}
                </div>
              )}
              {state.kind === 'error' && (
                <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5 text-[13px]">
                  <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
                  <span role="alert" className="min-w-48 flex-1">
                    {provisioningErrorText(state.message, t)}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void send(toCopy, null)}>
                    {t('login.retry')}
                  </Button>
                </div>
              )}
              {state.kind === 'done' && summary && (
                <>
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px]">
                    <CircleCheck className="size-4 shrink-0 text-status-ready" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      {t('create.progress.copied', {
                        count: importGroups.reduce((sum, group) => sum + summary.arrived[group], 0),
                      })}
                      <span className="block text-xs text-muted-foreground">
                        {list.format(
                          importGroups
                            .filter((group) => summary.arrived[group])
                            .map((group) => counted(group, summary.arrived[group]))
                        )}
                      </span>
                    </span>
                  </div>
                  {summary.failed.length > 0 && (
                    <div className="border-t border-border px-3.5 py-2.5">
                      <div className="flex flex-wrap items-center gap-2.5 text-[13px]">
                        <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
                        <span className="min-w-48 flex-1">
                          {t('create.progress.notCopied', { count: summary.failed.length })}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void send(failedImportChoice(state.report, toCopy), state.report)}
                        >
                          {t('login.retry')}
                        </Button>
                      </div>
                      <ul className="mt-1.5 flex flex-col gap-1 pl-[26px] text-xs text-muted-foreground">
                        {summary.failed.map((item) => (
                          <li key={`${item.group}:${item.id}`}>
                            <span className="text-foreground/75">{item.name}</span> ·{' '}
                            {provisioningErrorText(item.error, t, item.errorCode) || t('create.progress.failedItem')}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <details className="group border-t border-border">
                    <summary className="cursor-pointer px-3.5 py-2 text-[12.5px] text-foreground/75 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                      {t('create.progress.details')}
                    </summary>
                    <ul aria-label={t('provisioning.fromMac')} className="px-3.5 pb-2.5 text-[12.5px]">
                      {reportGroups.flatMap(([group, key]) =>
                        state.report[key].map((item) => (
                          <li key={`${group}:${item.id}`} className="flex justify-between gap-3 py-0.5">
                            <span className="truncate text-foreground/75">{item.name}</span>
                            <span
                              className={cn(
                                'shrink-0',
                                item.outcome === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                              )}
                            >
                              {t(`provisioning.groups.${group}`)} ·{' '}
                              {item.outcome === 'failed'
                                ? t('create.progress.failedItem')
                                : t(`provisioning.outcome.${item.outcome}`, { error: '' })}
                            </span>
                          </li>
                        ))
                      )}
                    </ul>
                  </details>
                </>
              )}
            </div>
          </section>
        )}

        {logins.length > 0 && subject && !failed && (
          <section aria-labelledby="create-progress-sign-in">
            <h4 id="create-progress-sign-in" className="mb-2 flex items-baseline gap-2 text-[13px] font-semibold">
              {t('create.progress.signIn')}
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {t('create.progress.signInCount', {
                  count: logins.filter((item) => stageOf(item.id) === 'done').length,
                  total: logins.length,
                })}
              </span>
            </h4>
            <div className="flex flex-col gap-2">
              {logins.map((item) => (
                <BotLoginCard
                  key={item.id}
                  subject={subject}
                  kind={item.kind}
                  label={item.label}
                  email={item.email}
                  stage={stageOf(item.id)}
                  account={stages[item.id]?.account ?? null}
                  next={item === nextLogin}
                  ready={canSend}
                  blocked={!!running && running !== item}
                  onStart={() => setStage(item.id, 'active')}
                  onCancel={() => setStage(item.id, 'todo')}
                  onSkip={() => setStage(item.id, 'skipped')}
                  onDone={(account) => setStage(item.id, 'done', account)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border py-3 pl-6 pr-4">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {!ready && !failed
            ? t('create.closeNote')
            : ready && pending && subject
              ? t(finishLaterKey(subject.target))
              : ''}
        </p>
        <Button variant="ghost" onClick={onClose}>
          {t('create.close')}
        </Button>
        <Button disabled={!ready && !failed} onClick={onOpen}>
          {t('create.progress.open', { name: bot.name })}
        </Button>
      </div>
    </>
  )
}
