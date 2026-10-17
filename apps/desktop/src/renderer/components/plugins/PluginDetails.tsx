import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Download, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  isBlockingReason,
  type PluginComponentDto,
  type PluginInspectionDto,
  type PluginMarketplaceDto,
} from '../../../shared/plugins'
import { CompatibilityBadge } from './CompatibilityBadge'
import { PluginLogo } from './PluginCard'
import type { PluginsSource } from './plugins-source'
import { normalizeSubagentProfileKey } from '../../../shared/subagent-profiles'
import { errorText, HookList, inputText, reasonText, SectionTitle, shortCommit } from './plugin-ui'

const STATUS_CLASS: Record<PluginComponentDto['status'], string> = {
  supported: 'text-emerald-300',
  adapted: 'text-sky-300',
  'not-run': 'text-amber-300',
  unavailable: 'text-red-300',
  invalid: 'text-red-300',
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  )
}

function openUrl(url: string) {
  void window.api.openExternalUrl(url)
}

/** Everything a person should know before installing: components, compatibility, license, endpoints and inputs. */
export function PluginDetails({
  source,
  marketplaceId,
  name,
  onBack,
  onInstall,
  reloadSignal,
  marketplaces,
}: {
  source: PluginsSource
  marketplaceId: string
  name: string
  onBack: () => void
  onInstall: (inspection: PluginInspectionDto) => void
  reloadSignal?: number
  /** Sources of the host, to say whether this plugin comes from a suggested source or from a third party. */
  marketplaces?: PluginMarketplaceDto[]
}) {
  const { t } = useTranslation('plugins')
  const [inspection, setInspection] = useState<PluginInspectionDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [licenseOpen, setLicenseOpen] = useState(false)

  useEffect(() => {
    let alive = true
    setInspection(null)
    setError(null)
    void source
      .pluginsInspect({ marketplaceId, name })
      .then((result) => {
        if (!alive) return
        if (result.ok) setInspection(result.value)
        else setError(errorText(t, result.error))
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [source, marketplaceId, name, reloadSignal])

  const back = (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex w-fit items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="h-3.5 w-3.5" /> {t('details.back')}
    </button>
  )
  if (error)
    return (
      <div className="flex flex-col gap-2">
        {back}
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      </div>
    )
  if (!inspection)
    return (
      <div className="flex flex-col gap-2">
        {back}
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('details.loading')}
        </p>
      </div>
    )

  const unavailable =
    inspection.compatibility?.level === 'unavailable' || inspection.policy.installation === 'NOT_AVAILABLE'
  const byKind = new Map<string, PluginComponentDto[]>()
  for (const component of inspection.components) {
    const list = byKind.get(component.kind) ?? []
    list.push(component)
    byKind.set(component.kind, list)
  }
  const repositoryUrl =
    inspection.links.repository ?? (inspection.source.url.startsWith('https://') ? inspection.source.url : null)
  const reasons = inspection.compatibility?.reasons ?? []
  const blocking = reasons.filter((reason) => isBlockingReason(reason.code))
  const notes = reasons.filter((reason) => !isBlockingReason(reason.code))
  const marketplace = marketplaces?.find((item) => item.id === marketplaceId)

  return (
    <div className="flex flex-col gap-3" data-testid="plugin-details">
      {back}
      <header className="flex items-start gap-3">
        <PluginLogo
          source={source}
          marketplaceId={marketplaceId}
          name={name}
          displayName={inspection.displayName}
          hasLogo={inspection.hasLogo}
          size={48}
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-foreground">{inspection.displayName}</h3>
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            {inspection.version && <span>{t('details.version', { version: inspection.version })}</span>}
            {inspection.publisher && <span>{t('details.by', { publisher: inspection.publisher })}</span>}
            {inspection.format && <span>{t(`details.format.${inspection.format}`)}</span>}
          </div>
          {inspection.description && <p className="mt-1 text-[12px] text-muted-foreground">{inspection.description}</p>}
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t('details.source')}:{' '}
            <span className="font-mono">
              {inspection.source.url}
              {inspection.source.path ? ` · ${inspection.source.path}` : ''} · {shortCommit(inspection.source.commit)}
            </span>
            {repositoryUrl && (
              <button
                type="button"
                onClick={() => openUrl(repositoryUrl)}
                className="ml-1.5 inline-flex items-center gap-0.5 text-indigo-300 hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> {t('details.openRepository')}
              </button>
            )}
          </div>
          {marketplace &&
            (marketplace.preset ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t(`details.publishedBy.${marketplace.preset}`)}
              </p>
            ) : (
              <p className="mt-0.5 text-[11px] text-amber-300" data-testid="third-party-source">
                {t('details.thirdPartySource')}
              </p>
            ))}
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => onInstall(inspection)}
          disabled={unavailable || inspection.installed}
          className="shrink-0"
        >
          <Download /> {inspection.installed ? t('browse.installed') : t('details.install')}
        </Button>
      </header>

      <Section title={t('details.compatibility')}>
        <div>
          <CompatibilityBadge compatibility={inspection.compatibility} />
        </div>
        {inspection.compatibility && (
          <p className="text-[11px] text-muted-foreground">{t(`compat.levelHint.${inspection.compatibility.level}`)}</p>
        )}
        {blocking.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <p className="text-[11px] font-medium text-foreground">{t('details.whyIncompatible')}</p>
            <ul className="list-disc pl-4 text-[12px] text-foreground">
              {blocking.map((reason, index) => (
                <li key={`${reason.code}-${reason.subject ?? index}`}>{reasonText(t, reason)}</li>
              ))}
            </ul>
          </div>
        )}
        {notes.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <p className="text-[11px] font-medium text-foreground">{t('details.notIncluded')}</p>
            <ul className="list-disc pl-4 text-[12px] text-muted-foreground">
              {notes.map((reason, index) => (
                <li key={`${reason.code}-${reason.subject ?? index}`}>{reasonText(t, reason)}</li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title={t('component.heading')}>
        <ul className="flex flex-col gap-1">
          {[...byKind.entries()].map(([kind, components]) => (
            <li key={kind} className="text-[12px]">
              <span className="text-foreground">{t(`component.kind.${kind}`)}</span>
              <ul className="mt-0.5 flex flex-col gap-0.5 pl-3">
                {components.map((component, index) => (
                  <li key={`${component.name}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                    <span className="font-mono text-muted-foreground">{component.name}</span>
                    <span className={STATUS_CLASS[component.status]}>{t(`component.status.${component.status}`)}</span>
                    {component.reason && (
                      <span className="text-muted-foreground">
                        {reasonText(t, { code: component.reason, component: component.kind, subject: component.name })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('details.skills')}>
        {inspection.skills.length ? (
          <ul className="flex flex-col gap-0.5">
            {inspection.skills.map((skill) => (
              <li key={`${skill.kind}-${skill.name}`} className="text-[12px]">
                <span className="font-mono text-foreground">
                  /{name}:{skill.name}
                </span>
                {skill.kind === 'command' && (
                  <span className="ml-1.5 rounded bg-white/[0.06] px-1 text-[10px] text-muted-foreground">
                    {t('details.command')}
                  </span>
                )}
                {skill.description && <span className="ml-1.5 text-muted-foreground">{skill.description}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-muted-foreground">{t('details.noSkills')}</p>
        )}
      </Section>

      {inspection.agents.length > 0 && (
        <Section title={t('details.agents')}>
          <p className="text-[11px] text-muted-foreground">{t('details.agentsHint')}</p>
          <ul className="flex flex-col gap-1">
            {inspection.agents.map((agent) => (
              <li key={agent.name} className="text-[12px]">
                <span className="font-mono text-foreground">
                  #{normalizeSubagentProfileKey(`${inspection.name}-${agent.name}`)}
                </span>
                <span className="ml-1.5 text-muted-foreground">{agent.description}</span>
                <div className="text-[11px] text-muted-foreground">
                  {agent.tools
                    ? t('details.agentTools', { tools: agent.tools.join(', ') })
                    : t('details.agentDefaultTools')}
                  {agent.droppedTools.length > 0 &&
                    ` · ${t('details.agentDropped', { tools: agent.droppedTools.join(', ') })}`}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {inspection.hooks.length > 0 && (
        <Section title={t('details.hooks')}>
          <p className="text-[11px] text-muted-foreground">{t('details.hooksHint')}</p>
          <HookList hooks={inspection.hooks} />
        </Section>
      )}

      <Section title={t('details.mcpServers')}>
        {inspection.mcpServers.length ? (
          <ul className="flex flex-col gap-1">
            {inspection.mcpServers.map((server) => (
              <li key={server.key} className="text-[12px]" data-mcp-server={server.key}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-foreground">{server.key}</span>
                  <span className="rounded bg-white/[0.06] px-1 text-[10px] text-muted-foreground">
                    {server.transport}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{t(`details.auth.${server.auth}`)}</span>
                </div>
                <div className="break-all font-mono text-[11px] text-muted-foreground">
                  {server.launch ?? server.endpoint}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-muted-foreground">{t('details.noMcpServers')}</p>
        )}
      </Section>

      {inspection.capabilities.length > 0 && (
        <Section title={t('details.capabilities')}>
          <div className="flex flex-wrap gap-1">
            {inspection.capabilities.map((capability) => (
              <span key={capability} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-foreground">
                {capability}
              </span>
            ))}
          </div>
        </Section>
      )}

      {inspection.endpoints.length > 0 && (
        <Section title={t('details.endpoints')}>
          <ul className="flex flex-col gap-0.5">
            {inspection.endpoints.map((endpoint) => (
              <li key={endpoint} className="break-all font-mono text-[11px] text-muted-foreground">
                {endpoint}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {inspection.executables.length > 0 && (
        <Section title={t('details.executables')}>
          <ul className="flex flex-col gap-0.5">
            {inspection.executables.map((file) => (
              <li key={file} className="font-mono text-[11px] text-muted-foreground">
                {file}
              </li>
            ))}
          </ul>
          {inspection.executablesTruncated && (
            <p className="text-[11px] text-muted-foreground">{t('details.executablesTruncated')}</p>
          )}
        </Section>
      )}

      <Section title={t('details.license')}>
        {inspection.license.spdx || inspection.license.text ? (
          <>
            {inspection.license.spdx && <p className="text-[12px] text-foreground">{inspection.license.spdx}</p>}
            {inspection.license.text && (
              <>
                <button
                  type="button"
                  onClick={() => setLicenseOpen((open) => !open)}
                  className="w-fit text-[11px] text-indigo-300 hover:underline"
                  aria-expanded={licenseOpen}
                >
                  {licenseOpen ? t('details.hideLicense') : t('details.showLicense')}
                </button>
                {licenseOpen && (
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-2 text-[11px] text-muted-foreground">
                    {inspection.license.text}
                  </pre>
                )}
              </>
            )}
          </>
        ) : (
          <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-200">{t('details.noLicense')}</p>
        )}
      </Section>

      {inspection.requirements.length > 0 && (
        <Section title={t('details.requirements')}>
          <p className="font-mono text-[12px] text-foreground">{inspection.requirements.join(', ')}</p>
        </Section>
      )}

      {inspection.inputs.length > 0 && (
        <Section title={t('details.inputs')}>
          <ul className="flex flex-col gap-0.5">
            {inspection.inputs.map((input) => {
              const { label, description } = inputText(t, input)
              return (
                <li key={input.id} className="text-[12px]">
                  <span className="text-foreground">{label}</span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {input.required ? t('install.required') : t('install.optional')}
                  </span>
                  {description && <span className="ml-1.5 text-muted-foreground">{description}</span>}
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      <Section title={t('details.policies')}>
        <p className="text-[12px] text-muted-foreground">
          {inspection.policy.authentication ? t(`details.authentication.${inspection.policy.authentication}`) : '—'}
          {inspection.policy.products.length
            ? ` · ${t('details.products', { products: inspection.policy.products.join(', ') })}`
            : ''}
        </p>
      </Section>

      {inspection.issues.length > 0 && (
        <Section title={t('details.issues')}>
          <ul className="flex flex-col gap-0.5">
            {inspection.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="text-[11px] text-muted-foreground">
                {issue.detail}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}
