import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import type { BotActionName, BotPermissionCeiling } from '../../../shared/bot'
import {
  BOT_ACTION_NAMES,
  BOT_PERMISSION_CEILING_NAMES,
  type BotProviderOption,
  type BotWorkspaceOption,
} from './config'

/** What the person grants a bot on this computer: projects, account/model pairs, actions and approval ceiling. */
export interface BotGrantDraft {
  workspaceIds: string[]
  selections: Array<{ providerId: string; modelId: string }>
  actions: BotActionName[]
  permissionCeiling: BotPermissionCeiling
}

interface Props {
  /** Makes the ids of these fields unique on the page: one per fleet bot. */
  scope: string
  /** Prefix of the fields' test ids. */
  testId?: string
  workspaces: BotWorkspaceOption[]
  providers: BotProviderOption[]
  value: BotGrantDraft
  onChange: (patch: Partial<BotGrantDraft>) => void
}

export const botChipClass =
  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border-strong px-3 py-1.5 text-xs ' +
  'transition-colors hover:bg-white/[0.04] has-[:checked]:border-sky-400 has-[:checked]:bg-sky-400/[0.1] ' +
  'has-[:checked]:text-sky-300 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 ' +
  'has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring'

/**
 * The grant a bot of the person's bot server gets on this computer: nothing is pre-selected by these fields, and the
 * person reads the strictest choice first.
 */
export function BotGrantFields({ scope, testId = 'bot-setup', workspaces, providers, value, onChange }: Props) {
  const { t } = useTranslation('ui')
  const toggleWorkspace = (id: string) =>
    onChange({
      workspaceIds: value.workspaceIds.includes(id)
        ? value.workspaceIds.filter((item) => item !== id)
        : [...value.workspaceIds, id],
    })

  return (
    <>
      <fieldset className="space-y-2">
        <legend className="mb-2 flex items-center gap-2 text-xs font-medium">
          {t('bots.projects')}
          <span className="text-[11px] font-normal text-muted-foreground">{t('bots.required')}</span>
        </legend>
        {workspaces.length ? (
          <div className="flex flex-wrap gap-2">
            {workspaces.map((workspace) => (
              <label key={workspace.id} className={botChipClass}>
                <input
                  type="checkbox"
                  className="size-3.5"
                  checked={value.workspaceIds.includes(workspace.id)}
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
                  const selected = value.selections.some(
                    (selection) => selection.providerId === provider.id && selection.modelId === modelId
                  )
                  return (
                    <label key={modelId} className={botChipClass}>
                      <input
                        type="checkbox"
                        className="size-3.5"
                        checked={selected}
                        onChange={() =>
                          onChange({
                            selections: selected
                              ? value.selections.filter(
                                  (selection) => selection.providerId !== provider.id || selection.modelId !== modelId
                                )
                              : [...value.selections, { providerId: provider.id, modelId }],
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
          const id = `bot-action-${scope}-${action.slice(6)}`
          return (
            <div key={action} className="flex items-start gap-2 py-1">
              <input
                id={id}
                type="checkbox"
                className="mt-0.5"
                checked={value.actions.includes(action)}
                onChange={() =>
                  onChange({
                    actions: value.actions.includes(action)
                      ? value.actions.filter((item) => item !== action)
                      : [...value.actions, action],
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

      <fieldset className="space-y-1" data-testid={`${testId}-ceiling`}>
        <legend className="flex items-center gap-1.5 text-xs font-medium">
          <ShieldCheck className="size-3.5" />
          {t('bots.ceiling.title')}
        </legend>
        <p className="pb-1 text-[11px] leading-relaxed text-muted-foreground">{t('bots.ceiling.hint')}</p>
        {BOT_PERMISSION_CEILING_NAMES.map((ceiling) => {
          const id = `bot-ceiling-${scope}-${ceiling}`
          return (
            <div key={ceiling} className="flex items-start gap-2 py-1">
              <input
                id={id}
                type="radio"
                className="mt-0.5"
                name={`bot-ceiling-${scope}`}
                checked={value.permissionCeiling === ceiling}
                onChange={() => onChange({ permissionCeiling: ceiling })}
              />
              <div className="min-w-0">
                <label htmlFor={id} className="block text-xs">
                  {t(`bots.ceiling.${ceiling}`)}
                </label>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{t(`bots.ceiling.${ceiling}Hint`)}</p>
              </div>
            </div>
          )
        })}
        {value.permissionCeiling === 'full' && (
          <p
            data-testid={`${testId}-ceiling-warning`}
            className="mt-1 rounded-md border border-amber-400/25 bg-amber-400/[0.06] p-2.5 text-[11px] leading-relaxed text-amber-200"
          >
            {t('bots.ceiling.fullWarning')}
          </p>
        )}
      </fieldset>
    </>
  )
}
