import { useTranslation } from 'react-i18next'
import { Bot, Check, ShieldCheck, X } from 'lucide-react'
import type { BotConnectionView, BotPendingAuthorization } from '../../../shared/bot'
import { Button } from '../ui/button'
import { OptionSelect, SelectOption } from '../ui/option-select'
import { cn } from '@/lib/utils'
import { Pill } from './pill'
import type { BotSetupDraft } from './setup-flow'
import {
  BOT_ACTION_NAMES,
  BOT_PERMISSION_CEILING_NAMES,
  inputClass,
  type BotProviderOption,
  type BotWorkspaceOption,
} from './config'

interface Props {
  request: BotPendingAuthorization
  /** Present only while this request is the one being set up; another request never borrows it. */
  setup: BotSetupDraft | null
  /** A bot already created for this request by an earlier attempt, reused instead of minting another. */
  mintedName: string | null
  workspaces: BotWorkspaceOption[]
  providers: BotProviderOption[]
  grantable: BotConnectionView[]
  chosen: string
  busy: boolean
  onOpenSetup: () => void
  onCancelSetup: () => void
  onEditSetup: (patch: Partial<BotSetupDraft>) => void
  onSubmit: () => void
  onDeny: () => void
  onReuse: (connectionId: string) => void
  onChoose: (connectionId: string) => void
  onAddProject?: () => void
  onOpenChatSettings?: () => void
}

interface Blocker {
  id: string
  text: string
  action?: { label: string; run: () => void }
}

const chipClass =
  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border-strong px-3 py-1.5 text-xs ' +
  'transition-colors hover:bg-white/[0.04] has-[:checked]:border-sky-400 has-[:checked]:bg-sky-400/[0.1] ' +
  'has-[:checked]:text-sky-300 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 ' +
  'has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring'

/**
 * One bot asking for access, and everything the person decides about it.
 *
 * The setup lives inside the request that asked for it, so nothing is ever filled in ahead of a bot, and
 * an approval that cannot happen yet says exactly what is missing instead of leaving a dead button.
 */
export function BotRequestCard(props: Props) {
  const { t } = useTranslation('ui')
  const { request, setup, mintedName, workspaces, providers, grantable, busy } = props

  const blockers: Blocker[] = []
  if (setup && !mintedName) {
    if (!setup.name.trim()) blockers.push({ id: 'name', text: t('bots.blockers.name') })
    if (!workspaces.length)
      blockers.push({
        id: 'no-projects',
        text: t('bots.blockers.noProjects'),
        ...(props.onAddProject ? { action: { label: t('bots.addProject'), run: props.onAddProject } } : {}),
      })
    else if (!setup.workspaceIds.length) blockers.push({ id: 'projects', text: t('bots.blockers.projects') })
    if (!providers.length)
      blockers.push({
        id: 'no-models',
        text: t('bots.blockers.noModels'),
        ...(props.onOpenChatSettings
          ? { action: { label: t('bots.openChatSettings'), run: props.onOpenChatSettings } }
          : {}),
      })
    else if (!setup.selections.length) blockers.push({ id: 'models', text: t('bots.blockers.models') })
    if (!setup.actions.length) blockers.push({ id: 'actions', text: t('bots.blockers.actions') })
  }

  const toggleWorkspace = (id: string) =>
    props.onEditSetup({
      workspaceIds: setup?.workspaceIds.includes(id)
        ? setup.workspaceIds.filter((value) => value !== id)
        : [...(setup?.workspaceIds ?? []), id],
    })

  return (
    <article
      data-testid="bot-pending-request"
      data-request={request.id}
      className="space-y-3 rounded-xl border border-sky-400/30 bg-sky-400/[0.04] p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-sm font-semibold">
          {request.clientName.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{request.clientName}</p>
          <p className="break-all text-[11px] text-muted-foreground">
            {t('bots.pendingRedirect', { uri: request.redirectUri })}
          </p>
        </div>
        <Pill tone="bot">{t('bots.requestWaiting')}</Pill>
      </div>

      {setup ? (
        <form
          className="space-y-4 border-t border-border pt-4"
          data-testid="bot-setup"
          onSubmit={(event) => {
            event.preventDefault()
            props.onSubmit()
          }}
        >
          <h4 className="text-sm font-medium">{t('bots.setupTitle', { name: request.clientName })}</h4>
          {mintedName ? (
            <p data-testid="bot-setup-reuse" className="text-xs leading-relaxed text-muted-foreground">
              {t('bots.createdRetry', { name: mintedName })}
            </p>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">{t('bots.setupDescription')}</p>

              <label className="block space-y-1.5 text-xs text-muted-foreground">
                <span>{t('bots.name')}</span>
                <input
                  required
                  maxLength={160}
                  value={setup.name}
                  onChange={(event) => props.onEditSetup({ name: event.target.value })}
                  className={inputClass}
                />
              </label>

              <fieldset className="space-y-2">
                <legend className="mb-2 flex items-center gap-2 text-xs font-medium">
                  {t('bots.projects')}
                  <span className="text-[11px] font-normal text-muted-foreground">{t('bots.required')}</span>
                </legend>
                {workspaces.length ? (
                  <div className="flex flex-wrap gap-2">
                    {workspaces.map((workspace) => (
                      <label key={workspace.id} className={chipClass}>
                        <input
                          type="checkbox"
                          className="size-3.5"
                          checked={setup.workspaceIds.includes(workspace.id)}
                          onChange={() => toggleWorkspace(workspace.id)}
                        />
                        {workspace.name}
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('bots.noProjects')}</p>
                )}
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="mb-2 flex items-center gap-2 text-xs font-medium">
                  {t('bots.models')}
                  <span className="text-[11px] font-normal text-muted-foreground">{t('bots.required')}</span>
                </legend>
                {providers.length ? (
                  providers.map((provider) => (
                    <div key={provider.id} className="space-y-2 rounded-md bg-muted/30 p-3">
                      <p className="text-[11px] text-muted-foreground">{provider.name}</p>
                      <div className="flex flex-wrap gap-2">
                        {provider.models.map((modelId) => {
                          const selected = setup.selections.some(
                            (selection) => selection.providerId === provider.id && selection.modelId === modelId
                          )
                          return (
                            <label key={modelId} className={chipClass}>
                              <input
                                type="checkbox"
                                className="size-3.5"
                                checked={selected}
                                onChange={() =>
                                  props.onEditSetup({
                                    selections: selected
                                      ? setup.selections.filter(
                                          (selection) =>
                                            selection.providerId !== provider.id || selection.modelId !== modelId
                                        )
                                      : [...setup.selections, { providerId: provider.id, modelId }],
                                  })
                                }
                              />
                              {modelId}
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">{t('bots.noModels')}</p>
                )}
              </fieldset>

              <fieldset className="space-y-1">
                <legend className="mb-2 flex items-center gap-1.5 text-xs font-medium">
                  <ShieldCheck className="size-3.5" />
                  {t('bots.permissions')}
                </legend>
                {BOT_ACTION_NAMES.map((action) => {
                  const id = `bot-action-${request.id}-${action.slice(6)}`
                  return (
                    <div key={action} className="flex items-start gap-2 py-1">
                      <input
                        id={id}
                        type="checkbox"
                        className="mt-0.5"
                        checked={setup.actions.includes(action)}
                        onChange={() =>
                          props.onEditSetup({
                            actions: setup.actions.includes(action)
                              ? setup.actions.filter((value) => value !== action)
                              : [...setup.actions, action],
                          })
                        }
                      />
                      <div className="min-w-0">
                        <label htmlFor={id} className="block text-xs">
                          {t(`bots.actions.${action.slice(6)}`)}
                        </label>
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {t(`bots.actionHints.${action.slice(6)}`)}
                        </p>
                      </div>
                    </div>
                  )
                })}
                <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">{t('bots.ownerGates')}</p>
              </fieldset>

              <fieldset className="space-y-1" data-testid="bot-setup-ceiling">
                <legend className="flex items-center gap-1.5 text-xs font-medium">
                  <ShieldCheck className="size-3.5" />
                  {t('bots.ceiling.title')}
                </legend>
                <p className="pb-1 text-[11px] leading-relaxed text-muted-foreground">{t('bots.ceiling.hint')}</p>
                {BOT_PERMISSION_CEILING_NAMES.map((ceiling) => {
                  const id = `bot-ceiling-${request.id}-${ceiling}`
                  return (
                    <div key={ceiling} className="flex items-start gap-2 py-1">
                      <input
                        id={id}
                        type="radio"
                        className="mt-0.5"
                        name={`bot-ceiling-${request.id}`}
                        checked={setup.permissionCeiling === ceiling}
                        onChange={() => props.onEditSetup({ permissionCeiling: ceiling })}
                      />
                      <div className="min-w-0">
                        <label htmlFor={id} className="block text-xs">
                          {t(`bots.ceiling.${ceiling}`)}
                        </label>
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {t(`bots.ceiling.${ceiling}Hint`)}
                        </p>
                      </div>
                    </div>
                  )
                })}
                {setup.permissionCeiling === 'full' && (
                  <p
                    data-testid="bot-setup-ceiling-warning"
                    className="mt-1 rounded-md border border-amber-400/25 bg-amber-400/[0.06] p-2.5 text-[11px] leading-relaxed text-amber-200"
                  >
                    {t('bots.ceiling.fullWarning')}
                  </p>
                )}
              </fieldset>
            </>
          )}

          {blockers.length > 0 && (
            <div
              data-testid="bot-setup-blockers"
              className="rounded-md border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs text-amber-200"
            >
              <p>{t('bots.blockersTitle')}</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                {blockers.map((blocker) => (
                  <li key={blocker.id}>
                    {blocker.text}
                    {blocker.action && (
                      <>
                        {' — '}
                        <button
                          type="button"
                          className="underline underline-offset-2 hover:no-underline"
                          onClick={blocker.action.run}
                        >
                          {blocker.action.label}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || blockers.length > 0}>
              <Check className="size-4" />
              {busy ? t('bots.working') : t('bots.createAndAllow')}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={props.onCancelSetup}>
              {t('bots.cancel')}
            </Button>
            <span className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-destructive"
              onClick={props.onDeny}
            >
              <X className="size-3.5" />
              {t('bots.deny')}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={props.onOpenSetup}>
              <Bot className="size-3.5" />
              {t('bots.configure')}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={props.onDeny}>
              <X className="size-3.5" />
              {t('bots.deny')}
            </Button>
          </div>
          {grantable.length > 0 && (
            <div className={cn('space-y-2 border-t border-border pt-3')}>
              <p className="text-xs leading-relaxed text-muted-foreground">{t('bots.reuseTitle')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <OptionSelect
                  aria-label={t('bots.pendingBot')}
                  value={props.chosen}
                  disabled={busy}
                  onValueChange={props.onChoose}
                >
                  {grantable.map((connection) => (
                    <SelectOption key={connection.id} value={connection.id}>
                      {connection.name}
                    </SelectOption>
                  ))}
                </OptionSelect>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || !props.chosen}
                  onClick={() => props.onReuse(props.chosen)}
                >
                  <Check className="size-3.5" />
                  {t('bots.allow')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </article>
  )
}
