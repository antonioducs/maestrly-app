import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Box, Copy, KeyRound, Laptop, LogIn, Plug, Puzzle } from 'lucide-react'
import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import type { MacInventory } from '../../../shared/fleet-provisioning'
import { Button } from '@/components/ui/button'
import { importGroupSize, macImportItems, sameImportChoice, selectedImportItems } from '@/lib/fleet/create-bot'
import {
  emptyImportChoice,
  hasImportChoice,
  importGroups,
  provisioningErrorText,
  recommendedImportChoice,
  useFleetProvisioning,
  type ImportChoice,
  type ImportGroup,
} from '@/lib/fleet/provisioning'

const groupIcon: Record<ImportGroup, ReactNode> = {
  accounts: <KeyRound className="size-4" />,
  skills: <Puzzle className="size-4" />,
  mcp: <Plug className="size-4" />,
}
const box = 'rounded-xl border border-border bg-foreground/[0.025]'
const iconTile = 'flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-foreground/5 text-foreground/75'

/** What a new environment brings from this Mac: a summary per kind, each opening the full list to choose from. */
export function MacImportSummary({
  inventory,
  error,
  value,
  onChange,
  onChoose,
}: {
  inventory: MacInventory | null
  error: string
  value: ImportChoice
  onChange: (value: ImportChoice) => void
  onChoose: (group: ImportGroup) => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' })
  if (error)
    return (
      <p role="alert" className="text-xs text-destructive">
        {provisioningErrorText(error, t)}
      </p>
    )
  if (!inventory)
    return (
      <div role="status" className={`${box} flex items-center gap-2.5 px-3.5 py-4 text-[13px] text-muted-foreground`}>
        <span
          aria-hidden="true"
          className="size-4 animate-spin rounded-full border-2 border-foreground/15 border-t-foreground motion-reduce:animate-none"
        />
        {t('create.import.loading')}
      </div>
    )
  const items = macImportItems(inventory)
  const total = importGroups.reduce((sum, group) => sum + items[group].length, 0)
  if (!total)
    return (
      <div className={`${box} flex items-center gap-3 p-3.5 text-[13px] text-muted-foreground`}>
        <Laptop className="size-4 shrink-0" aria-hidden="true" />
        {t('create.import.nothing')}
      </div>
    )
  const recommended = recommendedImportChoice(inventory, importGroups)
  const hasLogins = items.accounts.some((item) => item.field === 'loginIds')
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap justify-end gap-2 empty:hidden">
        {!sameImportChoice(value, recommended) && hasImportChoice(recommended) && (
          <Button
            size="sm"
            variant="outline"
            title={t('create.import.recommendedHint')}
            onClick={() => onChange(recommended)}
          >
            {t('create.import.recommended')}
          </Button>
        )}
        {hasImportChoice(value) && (
          <Button size="sm" variant="ghost" onClick={() => onChange(emptyImportChoice())}>
            {t('provisioning.clear')}
          </Button>
        )}
      </div>
      <div className={box}>
        <ul className="divide-y divide-border">
          {importGroups.map((group) => {
            const selected = selectedImportItems(value, items[group])
            const names = selected.slice(0, 3).map((item) => item.name)
            const logins = selected.filter((item) => item.field === 'loginIds').map((item) => item.name)
            return (
              <li key={group} className="flex flex-wrap items-center gap-3 px-3.5 py-3 sm:flex-nowrap">
                <span aria-hidden="true" className={iconTile}>
                  {groupIcon[group]}
                </span>
                <div className="flex min-w-0 flex-1 basis-40 flex-col gap-px">
                  <span className="flex flex-wrap items-baseline gap-2 text-[13.5px] font-medium">
                    {t(`create.import.group.${group}`)}
                    <span className="text-xs font-normal tabular-nums text-muted-foreground">
                      {t('create.import.count', { count: importGroupSize(value, group), total: items[group].length })}
                    </span>
                  </span>
                  <span
                    className={`truncate text-[12.5px] ${selected.length ? 'text-foreground/75' : 'text-muted-foreground'}`}
                  >
                    {selected.length
                      ? names.join(', ') + (selected.length > names.length ? ` +${selected.length - names.length}` : '')
                      : t(`create.import.none.${group}`)}
                  </span>
                  {logins.length > 0 && (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <LogIn className="size-3 shrink-0" aria-hidden="true" />
                      {t('create.import.signInLater', { names: list.format(logins) })}
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-11 sm:ml-0"
                  disabled={!items[group].length}
                  aria-label={t(`create.import.choose.${group}`)}
                  data-choose={group}
                  onClick={() => onChoose(group)}
                >
                  {t('create.import.chooseButton')}
                </Button>
              </li>
            )
          })}
        </ul>
        <div className="flex flex-col gap-1.5 rounded-b-xl border-t border-border bg-black/15 px-3.5 py-2.5 text-xs text-muted-foreground">
          <span className="flex items-start gap-2">
            <Copy className="mt-px size-3.5 shrink-0 text-foreground/75" aria-hidden="true" />
            <span>
              <b className="font-medium text-foreground/75">{t('create.import.copiedLead')}</b>{' '}
              {t('create.import.copiedNote')}
            </span>
          </span>
          {hasLogins && (
            <span className="flex items-start gap-2">
              <LogIn className="mt-px size-3.5 shrink-0 text-foreground/75" aria-hidden="true" />
              <span>
                <b className="font-medium text-foreground/75">{t('create.import.signInLead')}</b>{' '}
                {t('create.import.signInNote')}
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** What a bot joining an existing environment starts with: its shared accounts, skills and MCP servers. */
export function EnvironmentShares({
  environment,
  canList,
}: {
  environment: FleetEnvironment | undefined
  /** The environment runs and can list them. */
  canList: boolean
}) {
  const { t } = useTranslation('fleet')
  const lists = useFleetProvisioning({ environmentId: environment?.id ?? '' }, Boolean(environment) && canList)
  if (!environment)
    return (
      <div className={`${box} flex items-center gap-3 p-3.5 text-[13px] text-muted-foreground`}>
        <Box className="size-4 shrink-0" aria-hidden="true" />
        {t('create.import.chooseEnvironment')}
      </div>
    )
  const count = (value: number | undefined) => (value === undefined ? '…' : String(value))
  const stats = [
    ['accounts', lists.accounts ? lists.accounts.apiKeys.length + lists.accounts.subscriptions.length : undefined],
    ['skills', lists.skills?.length],
    ['mcp', lists.mcpServers?.length],
  ] as const
  return (
    <div className={`${box} flex flex-col gap-3 p-3.5`}>
      <p className="text-[13px] text-foreground/75">{t('create.sharedHint', { environment: environment.name })}</p>
      {canList && (
        <dl className="m-0 grid grid-cols-3 divide-x divide-border rounded-[10px] border border-border">
          {stats.map(([group, value]) => (
            <div key={group} className="px-3 py-2">
              <dt className="text-[11.5px] text-muted-foreground">{t(`create.import.group.${group}`)}</dt>
              <dd className="m-0 mt-px text-[17px] font-semibold tabular-nums">{count(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-xs text-muted-foreground">{t('create.import.moreLater', { environment: environment.name })}</p>
    </div>
  )
}
