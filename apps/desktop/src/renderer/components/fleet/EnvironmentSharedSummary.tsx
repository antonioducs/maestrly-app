import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, ChevronRight, FoldVertical, Globe, KeyRound, Layers, Wrench, type LucideIcon } from 'lucide-react'
import type { FleetBot, FleetEnvironment, FleetSettingsOutput } from '@maestrly/bot-fleet-protocol'
import { compactionSourceOf } from '@/lib/fleet/compaction'
import { formatNames } from '@/lib/fleet/environments'
import { useEnvironmentSettingsResource } from '@/lib/fleet/environment-settings'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { EnvironmentSettingsSection } from './environment-settings/sections'

/**
 * What every bot of an environment gets from it, at a glance: its accounts, models, skills, MCP servers, default
 * compaction model and site logins. Each opens where it is changed. It reads the environment's settings only while the
 * environment runs; otherwise it says what would make them readable.
 */
export function EnvironmentSharedSummary({
  environment,
  fleet,
  bots,
  onOpenSettings,
  onOpenScreen,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  bots: FleetBot[]
  onOpenSettings: (section: EnvironmentSettingsSection) => void
  onOpenScreen: () => void
}) {
  const { t } = useTranslation('fleet')
  const connected = fleet.state.connection.state === 'connected'
  const running = environment.lifecycle === 'running'
  const stopped = environment.lifecycle === 'stopped' || environment.lifecycle === 'failed'
  const reason = !connected
    ? t('environmentSettingsShell.offline')
    : stopped
      ? t('environmentSettingsShell.stopped')
      : !running
        ? t('environment.compaction.waitToChange')
        : null
  return (
    <section aria-labelledby="fleet-environment-shared">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="fleet-environment-shared" className="text-[15px] font-semibold">
          {t('environment.sharedTitle')}
        </h2>
        <button
          type="button"
          onClick={() => onOpenSettings('accounts')}
          className="inline-flex h-[26px] items-center gap-1 rounded-lg px-2 text-xs text-foreground/75 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('environment.allSettings')}
          <ChevronRight aria-hidden="true" className="size-3" />
        </button>
      </div>
      {reason ? (
        <Tiles
          environment={environment}
          bots={bots}
          onOpenSettings={onOpenSettings}
          onOpenScreen={onOpenScreen}
          unavailable
        />
      ) : (
        <ReadTiles environment={environment} bots={bots} onOpenSettings={onOpenSettings} onOpenScreen={onOpenScreen} />
      )}
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
        {reason ?? t('environment.sharedSetupNote')}
      </p>
    </section>
  )
}

type Data = {
  accounts: FleetSettingsOutput<'accounts'> | null
  models: FleetSettingsOutput<'models'> | null
  skills: FleetSettingsOutput<'skills'> | null
  mcp: FleetSettingsOutput<'mcpServers'> | null
}

function ReadTiles(props: Omit<Parameters<typeof Tiles>[0], 'data' | 'unavailable'>) {
  const accounts = useEnvironmentSettingsResource(props.environment.id, 'accounts')
  const models = useEnvironmentSettingsResource(props.environment.id, 'models')
  const skills = useEnvironmentSettingsResource(props.environment.id, 'skills')
  const mcp = useEnvironmentSettingsResource(props.environment.id, 'mcpServers')
  return (
    <Tiles
      {...props}
      data={{ accounts: accounts.data, models: models.data, skills: skills.data, mcp: mcp.data }}
      failed={{ accounts: accounts.error, models: models.error, skills: skills.error, mcp: mcp.error }}
    />
  )
}

function Tiles({
  environment,
  bots,
  data,
  failed,
  unavailable = false,
  onOpenSettings,
  onOpenScreen,
}: {
  environment: FleetEnvironment
  bots: FleetBot[]
  data?: Data
  failed?: Record<keyof Data, boolean>
  unavailable?: boolean
  onOpenSettings: (section: EnvironmentSettingsSection) => void
  onOpenScreen: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const list = (names: string[]) => formatNames(names, i18n.language)
  /** A tile's value: its text once read, an ellipsis while it is read, a dash when it cannot be. */
  const value = <K extends keyof Data>(key: K, read: (value: NonNullable<Data[K]>) => string): string => {
    if (unavailable || failed?.[key]) return '—'
    const loaded = data?.[key]
    return loaded ? read(loaded as NonNullable<Data[K]>) : '…'
  }
  const sub = <K extends keyof Data>(key: K, read: (value: NonNullable<Data[K]>) => string): string => {
    const loaded = data?.[key]
    return unavailable || failed?.[key] || !loaded ? '' : read(loaded as NonNullable<Data[K]>)
  }
  const accountNames = (accounts: NonNullable<Data['accounts']>) => [
    ...accounts.subscriptions.map((account) => account.label),
    ...accounts.apiKeys.map((account) => account.name),
  ]
  const modelCount = (models: NonNullable<Data['models']>) => {
    const total = models.providers.reduce((sum, provider) => sum + provider.models.length, 0)
    const hidden = models.providers.reduce(
      (sum, provider) => sum + provider.models.filter((model) => provider.hiddenModelIds.includes(model.id)).length,
      0
    )
    return { total, hidden, visible: total - hidden }
  }
  const compaction = environment.compaction
  const compactionLabel = (): string => {
    if (!compaction) return t('environment.tiles.compactionUnset')
    const provider = data?.models?.providers.find((item) => item.providerId === compaction.providerId)
    const model = provider?.models.find((item) => item.id === compaction.modelId)
    return provider ? `${provider.name} · ${model?.name ?? compaction.modelId}` : compaction.modelId
  }
  const users = bots.filter((bot) => compactionSourceOf(bot) === 'environment').map((bot) => bot.name)
  return (
    <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2 @2xl:grid-cols-3">
      <Tile
        icon={KeyRound}
        label={t('environmentSettingsShell.sections.accounts')}
        value={value('accounts', (accounts) => {
          const count = accounts.subscriptions.length + accounts.apiKeys.length
          return count ? t('environment.tiles.accounts', { count }) : t('environment.tiles.noAccounts')
        })}
        sub={sub('accounts', (accounts) => accountNames(accounts).join(' · ') || t('environment.tiles.addAccount'))}
        onClick={() => onOpenSettings('accounts')}
      />
      <Tile
        icon={Layers}
        label={t('environmentSettingsShell.sections.models')}
        value={value('models', (models) => {
          const { visible, total } = modelCount(models)
          return total ? t('environment.tiles.modelsVisible', { count: visible }) : t('environment.tiles.noModels')
        })}
        sub={sub('models', (models) => {
          const { hidden, total } = modelCount(models)
          return !total
            ? ''
            : hidden
              ? t('environment.tiles.modelsHidden', { count: hidden, total })
              : t('environment.tiles.modelsAllVisible')
        })}
        onClick={() => onOpenSettings('models')}
      />
      <Tile
        icon={BookOpen}
        label={t('environmentSettingsShell.sections.skills')}
        value={value('skills', (skills) =>
          skills.skills.length
            ? t('environment.tiles.skills', { count: skills.skills.length })
            : t('environment.tiles.noSkills')
        )}
        sub={sub('skills', (skills) => skills.skills.map((skill) => skill.name).join(', '))}
        onClick={() => onOpenSettings('skills')}
      />
      <Tile
        icon={Wrench}
        label={t('environmentSettingsShell.sections.tools')}
        value={value('mcp', (mcp) =>
          mcp.servers.length ? t('environment.tiles.mcp', { count: mcp.servers.length }) : t('environment.tiles.noMcp')
        )}
        sub={sub('mcp', (mcp) => {
          const off = mcp.servers.filter((server) => !server.enabled).length
          return !mcp.servers.length
            ? ''
            : off
              ? t('environment.tiles.mcpOff', { count: off })
              : t('environment.tiles.mcpAllOn')
        })}
        onClick={() => onOpenSettings('tools')}
      />
      <Tile
        icon={FoldVertical}
        label={t('environment.tiles.compaction')}
        value={unavailable && !compaction ? '—' : compactionLabel()}
        sub={
          !compaction
            ? ''
            : users.length
              ? t('environment.tiles.compactionUsedBy', { bots: list(users) })
              : t('environment.compaction.usedByNone')
        }
        onClick={() => onOpenSettings('preferences')}
      />
      <Tile
        icon={Globe}
        label={t('environment.tiles.siteLogins')}
        value={t('environment.tiles.siteLoginsValue')}
        sub={t('environment.tiles.siteLoginsNote')}
        onClick={onOpenScreen}
      />
    </div>
  )
}

function Tile({
  icon: Icon,
  label,
  value,
  sub,
  onClick,
}: {
  icon: LucideIcon
  label: string
  value: ReactNode
  sub: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-w-0 flex-col gap-[3px] rounded-[11px] border border-border bg-white/[0.02] px-3.5 pb-[13px] pt-3 text-left transition-colors hover:border-border-strong hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="mb-[3px] flex items-center gap-[7px] text-[11.5px] text-muted-foreground">
        <Icon aria-hidden="true" className="size-3 shrink-0" />
        {label}
        <ChevronRight
          aria-hidden="true"
          className="ml-auto size-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </span>
      <span className="truncate text-[13.5px] font-medium">{value}</span>
      <span className="min-h-[18px] truncate text-xs text-muted-foreground">{sub}</span>
    </button>
  )
}
