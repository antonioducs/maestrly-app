import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpCircle, Eye, Loader2, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useHostId } from '@/lib/hosts/host-context'
import { LOCAL_HOST_ID } from '../../../shared/host-key'
import {
  isBlockingReason,
  type InstalledPluginDto,
  type PluginInspectionDto,
  type PluginMcpServerDto,
  type PluginScope,
} from '../../../shared/plugins'
import { CompatibilityBadge } from './CompatibilityBadge'
import { PluginInputsForm } from './PluginInputsForm'
import { PluginInstallDialog } from './PluginInstallDialog'
import { PluginScopePicker, scopeIsComplete } from './PluginScopePicker'
import { McpSignIn } from '../chat/McpSignIn'
import type { PluginsSource } from './plugins-source'
import { errorText, reasonText, shortCommit, Toggle } from './plugin-ui'

type Editing =
  | { key: string; kind: 'scope'; scope: PluginScope }
  | { key: string; kind: 'inputs'; values: Record<string, string> }

/** Installed plugins: enablement, scope, versions and updates, servers, settings and removal. */
export function InstalledPlugins({
  source,
  installed,
  onChanged,
  onOpenDetails,
}: {
  source: PluginsSource
  installed: InstalledPluginDto[]
  onChanged: () => void
  onOpenDetails: (plugin: InstalledPluginDto) => void
}) {
  const { t } = useTranslation('plugins')
  const remoteHost = useHostId() !== LOCAL_HOST_ID || source.remote
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [stdioConsent, setStdioConsent] = useState<{ plugin: InstalledPluginDto; server: PluginMcpServerDto } | null>(
    null
  )
  const [updating, setUpdating] = useState<{ plugin: InstalledPluginDto; inspection: PluginInspectionDto } | null>(null)
  const [removing, setRemoving] = useState<InstalledPluginDto | null>(null)
  const [deleteData, setDeleteData] = useState(false)

  const run = async (key: string, operation: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    setBusy(key)
    setError(null)
    try {
      const result = await operation()
      if (!result.ok) {
        setError({ key, message: errorText(t, result.error) })
        return false
      }
      source.notifyChanged()
      onChanged()
      return true
    } catch (cause) {
      setError({ key, message: cause instanceof Error ? cause.message : String(cause) })
      return false
    } finally {
      setBusy(null)
    }
  }

  const update = async (plugin: InstalledPluginDto) => {
    setBusy(plugin.key)
    setError(null)
    try {
      const result = await source.pluginsUpdate({ key: plugin.key })
      if (result.ok) {
        source.notifyChanged()
        onChanged()
        return
      }
      if (result.error !== 'consent-required') {
        setError({ key: plugin.key, message: errorText(t, result.error) })
        return
      }
      const inspection = await source.pluginsInspect({ marketplaceId: plugin.marketplaceId, name: plugin.name })
      if (!inspection.ok) setError({ key: plugin.key, message: errorText(t, inspection.error) })
      else setUpdating({ plugin, inspection: inspection.value })
    } finally {
      setBusy(null)
    }
  }

  if (!installed.length) return <p className="text-[12px] text-muted-foreground">{t('installed.empty')}</p>

  return (
    <div className="flex flex-col gap-2">
      {installed.map((plugin) => {
        const rowBusy = busy === plugin.key
        const edit = editing?.key === plugin.key ? editing : null
        // A plugin that stopped working the same with every model never applies; it can be updated or uninstalled.
        const incompatible = plugin.compatibility?.level === 'unavailable'
        const blockingReason = incompatible
          ? (plugin.compatibility?.reasons.find((reason) => isBlockingReason(reason.code)) ??
            plugin.compatibility?.reasons[0])
          : undefined
        return (
          <div
            key={plugin.key}
            data-installed-plugin={plugin.key}
            className="flex flex-col gap-2 rounded-lg border border-border bg-white/[0.02] p-2.5"
          >
            <div className="flex items-start gap-2">
              <Toggle
                on={plugin.enabled && !incompatible}
                disabled={rowBusy || incompatible}
                label={`${t('installed.enable')}: ${plugin.displayName}`}
                onClick={() =>
                  void run(plugin.key, () => source.pluginsSetEnabled({ key: plugin.key, enabled: !plugin.enabled }))
                }
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium text-foreground">{plugin.displayName}</span>
                  <CompatibilityBadge compatibility={plugin.compatibility} />
                  {plugin.setup.missingInputs.length > 0 && (
                    <button
                      type="button"
                      className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-200"
                      onClick={() => setEditing({ key: plugin.key, kind: 'inputs', values: {} })}
                    >
                      {t('setup.missingInputs')}
                    </button>
                  )}
                  {plugin.setup.stdioNeedingConsent.length > 0 && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-200">
                      {t('setup.needsConsent')}
                    </span>
                  )}
                  {plugin.setup.serversNeedingAuth.length > 0 && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-200">
                      {t('setup.needsAuth')}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {plugin.version ? `${t('installed.version', { version: plugin.version })} · ` : ''}
                  {t('installed.commit', { commit: shortCommit(plugin.commit) })} · {t('installed.scope')}{' '}
                  {plugin.scope.kind === 'global'
                    ? t('installed.scopeGlobal')
                    : t('installed.scopeProjects', { count: plugin.scope.workspaceIds.length })}{' '}
                  {/* A bot environment's plugins always serve all of its conversations. */}
                  {!source.bring && !incompatible && (
                    <button
                      type="button"
                      className="text-indigo-300 hover:underline"
                      onClick={() => setEditing({ key: plugin.key, kind: 'scope', scope: plugin.scope })}
                    >
                      {t('installed.change')}
                    </button>
                  )}
                </div>
                {blockingReason && (
                  <p className="text-[11px] text-red-300" data-testid="installed-incompatible">
                    {reasonText(t, blockingReason)}
                  </p>
                )}
                {plugin.skills.length > 0 && (
                  <div className="truncate text-[11px] text-muted-foreground">
                    {t('installed.skills', { count: plugin.skills.length })}:{' '}
                    {plugin.skills.map((skill) => skill.name).join(', ')}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {rowBusy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                {plugin.updateAvailable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[12px]"
                    disabled={rowBusy}
                    onClick={() => void update(plugin)}
                  >
                    <ArrowUpCircle /> {t('installed.update')}
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => onOpenDetails(plugin)}
                  className="text-muted-foreground hover:text-foreground"
                  title={t('installed.details')}
                  aria-label={`${t('installed.details')}: ${plugin.displayName}`}
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
                {plugin.inputs.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setEditing({ key: plugin.key, kind: 'inputs', values: {} })}
                    className="text-muted-foreground hover:text-foreground"
                    title={t('installed.editInputs')}
                    aria-label={`${t('installed.editInputs')}: ${plugin.displayName}`}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDeleteData(false)
                    setRemoving(plugin)
                  }}
                  className="text-muted-foreground hover:text-destructive"
                  title={t('installed.uninstall')}
                  aria-label={`${t('installed.uninstall')}: ${plugin.displayName}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {plugin.mcpServers.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-border/60 pt-1.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t('installed.servers')}
                </div>
                {plugin.mcpServers.map((server) => (
                  <div key={server.key} className="flex items-center gap-2 text-[12px]">
                    <Toggle
                      on={server.enabled === true}
                      disabled={rowBusy || incompatible || server.auth === 'unusable'}
                      label={`${server.key}`}
                      onClick={() => {
                        const enabling = server.enabled !== true
                        if (enabling && server.transport === 'stdio' && !server.consented) {
                          setStdioConsent({ plugin, server })
                          return
                        }
                        void run(plugin.key, () =>
                          source.pluginsSetServer({ key: plugin.key, serverKey: server.key, enabled: enabling })
                        )
                      }}
                    />
                    <span className="text-foreground">{server.key}</span>
                    <span className="rounded bg-white/[0.06] px-1 text-[10px] text-muted-foreground">
                      {server.transport}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                      {server.endpoint}
                    </span>
                    {/* A bot environment keeps its sign-ins; this computer's browser runs them through its source. */}
                    {(!source.remote || source.mcpSignIn) &&
                      server.id &&
                      server.enabled &&
                      server.authStatus !== undefined && (
                        <McpSignIn
                          actions={source.mcpSignIn}
                          serverId={server.id}
                          auth={server.authStatus === 'none' ? undefined : server.authStatus}
                          onChanged={() => {
                            source.notifyChanged()
                            onChanged()
                          }}
                          className="shrink-0"
                        />
                      )}
                  </div>
                ))}
              </div>
            )}

            {edit?.kind === 'scope' && (
              <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
                <PluginScopePicker
                  source={source}
                  value={edit.scope}
                  onChange={(scope) => setEditing({ key: plugin.key, kind: 'scope', scope })}
                  disabled={rowBusy}
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                    {t('installed.cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={rowBusy || !scopeIsComplete(edit.scope)}
                    onClick={() =>
                      void run(plugin.key, () => source.pluginsSetScope({ key: plugin.key, scope: edit.scope })).then(
                        (ok) => ok && setEditing(null)
                      )
                    }
                  >
                    {t('installed.save')}
                  </Button>
                </div>
              </div>
            )}

            {edit?.kind === 'inputs' && (
              <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
                <PluginInputsForm
                  inputs={plugin.inputs}
                  values={edit.values}
                  onChange={(values) => setEditing({ key: plugin.key, kind: 'inputs', values })}
                  disabled={rowBusy}
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                    {t('installed.cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={rowBusy}
                    onClick={() => {
                      const values = Object.fromEntries(
                        Object.entries(edit.values).filter(([, value]) => value.trim() !== '')
                      )
                      void run(plugin.key, () => source.pluginsSetInputs({ key: plugin.key, values })).then(
                        (ok) => ok && setEditing(null)
                      )
                    }}
                  >
                    {t('installed.save')}
                  </Button>
                </div>
              </div>
            )}

            {error?.key === plugin.key && (
              <p role="alert" className="text-[12px] text-destructive">
                {error.message}
              </p>
            )}
          </div>
        )
      })}

      {stdioConsent && (
        <Dialog open onOpenChange={(open) => !open && setStdioConsent(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{stdioConsent.server.key}</DialogTitle>
              <DialogDescription>
                {remoteHost ? t('install.consentStdioRemote') : t('install.consentStdio')}
              </DialogDescription>
            </DialogHeader>
            <pre className="whitespace-pre-wrap break-all rounded-md bg-black/30 p-2 font-mono text-[11px] text-muted-foreground">
              {stdioConsent.server.launch}
            </pre>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setStdioConsent(null)}>
                {t('installed.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  const { plugin, server } = stdioConsent
                  setStdioConsent(null)
                  void run(plugin.key, () =>
                    source.pluginsSetServer({ key: plugin.key, serverKey: server.key, enabled: true, consent: true })
                  )
                }}
              >
                {t('installed.enable')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {updating && (
        <PluginInstallDialog
          source={source}
          inspection={updating.inspection}
          mode={{ kind: 'update', key: updating.plugin.key }}
          onClose={() => setUpdating(null)}
          onDone={() => {
            setUpdating(null)
            onChanged()
          }}
          onReinspect={() => {
            void source
              .pluginsInspect({ marketplaceId: updating.plugin.marketplaceId, name: updating.plugin.name })
              .then((result) => result.ok && setUpdating({ plugin: updating.plugin, inspection: result.value }))
          }}
        />
      )}

      {removing && (
        <Dialog open onOpenChange={(open) => !open && busy === null && setRemoving(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('uninstall.title', { name: removing.displayName })}</DialogTitle>
              <DialogDescription>{t('uninstall.message')}</DialogDescription>
            </DialogHeader>
            <label className="flex items-center gap-2 text-[12px] text-foreground">
              <input type="checkbox" checked={deleteData} onChange={(event) => setDeleteData(event.target.checked)} />
              {t('uninstall.deleteData')}
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRemoving(null)}
                disabled={busy !== null}
              >
                {t('installed.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  const plugin = removing
                  void run(plugin.key, () => source.pluginsUninstall({ key: plugin.key, deleteData })).then(() =>
                    setRemoving(null)
                  )
                }}
              >
                {busy !== null && <Loader2 className="animate-spin" />}
                {t('uninstall.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
