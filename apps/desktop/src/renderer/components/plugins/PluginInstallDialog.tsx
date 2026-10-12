import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, TerminalSquare } from 'lucide-react'
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
import type { InstalledPluginDto, PluginInspectionDto, PluginScope } from '../../../shared/plugins'
import { PluginInputsForm } from './PluginInputsForm'
import { PluginScopePicker, scopeIsComplete } from './PluginScopePicker'
import type { PluginsSource } from './plugins-source'
import { errorText } from './plugin-ui'

export type InstallMode = { kind: 'install' } | { kind: 'update'; key: string }

/**
 * Explicit consent before anything of a plugin runs: each stdio server by its exact launch line, scripts and
 * executables, plus where it applies and the values it needs. An update shows the same consent for the new version.
 */
export function PluginInstallDialog({
  source,
  inspection,
  mode,
  onClose,
  onDone,
  onReinspect,
}: {
  source: PluginsSource
  inspection: PluginInspectionDto
  mode: InstallMode
  onClose: () => void
  onDone: (plugin: InstalledPluginDto) => void
  onReinspect: () => void
}) {
  const { t } = useTranslation('plugins')
  const remoteHost = useHostId() !== LOCAL_HOST_ID || source.remote
  const stdio = inspection.mcpServers.filter((server) => server.transport === 'stdio')
  const [approved, setApproved] = useState<Set<string>>(
    () => new Set(stdio.filter((server) => server.consented).map((server) => server.key))
  )
  const [executables, setExecutables] = useState(false)
  const [scope, setScope] = useState<PluginScope>({ kind: 'global' })
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsExecutables = inspection.executables.length > 0
  const ready = (!needsExecutables || executables) && (mode.kind === 'update' || scopeIsComplete(scope))

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    const consent = {
      consentFingerprint: inspection.consentFingerprint,
      stdio: [...approved],
      executables: needsExecutables ? executables : false,
    }
    try {
      const inputs = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()))
      const result =
        mode.kind === 'install'
          ? await source.pluginsInstall({
              marketplaceId: inspection.marketplaceId,
              name: inspection.name,
              consent,
              scope,
              ...(Object.keys(inputs).length ? { inputs } : {}),
            })
          : await source.pluginsUpdate({ key: mode.key, consent })
      if (!result.ok) {
        if (result.error === 'consent-required') {
          setError(t('install.sourceChanged'))
          onReinspect()
        } else setError(errorText(t, result.error))
        return
      }
      source.notifyChanged()
      onDone(result.value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[88vh] max-w-xl overflow-y-auto"
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onPointerDownOutside={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {mode.kind === 'install'
              ? t('install.title', { name: inspection.displayName })
              : t('update.title', { name: inspection.displayName })}
          </DialogTitle>
          <DialogDescription>
            {mode.kind === 'update'
              ? t('update.description')
              : remoteHost
                ? t('install.descriptionRemote')
                : t('install.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {stdio.length > 0 && (
            <fieldset className="flex flex-col gap-2" disabled={busy}>
              <legend className="mb-1 text-[12px] font-medium text-foreground">{t('details.mcpServers')}</legend>
              {stdio.map((server) => (
                <label
                  key={server.key}
                  className="flex items-start gap-2 rounded-md border border-border bg-black/20 p-2 text-[12px]"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={approved.has(server.key)}
                    onChange={(event) => {
                      const next = new Set(approved)
                      if (event.target.checked) next.add(server.key)
                      else next.delete(server.key)
                      setApproved(next)
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground">
                      {remoteHost ? t('install.consentStdioRemote') : t('install.consentStdio')}: {server.key}
                    </span>
                    <span className="mt-0.5 flex items-start gap-1 break-all font-mono text-[11px] text-muted-foreground">
                      <TerminalSquare className="mt-0.5 h-3 w-3 shrink-0" />
                      {server.launch}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {needsExecutables && (
            <label className="flex items-start gap-2 text-[12px] text-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={executables}
                disabled={busy}
                onChange={(event) => setExecutables(event.target.checked)}
              />
              <span>
                {t('install.consentExecutables')}
                <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                  {inspection.executables.slice(0, 5).join(', ')}
                  {inspection.executables.length > 5 || inspection.executablesTruncated ? ' …' : ''}
                </span>
              </span>
            </label>
          )}
          {mode.kind === 'install' && (
            <>
              <PluginScopePicker source={source} value={scope} onChange={setScope} disabled={busy} />
              <PluginInputsForm inputs={inspection.inputs} values={values} onChange={setValues} disabled={busy} />
            </>
          )}
          {error && (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('installed.cancel')}
          </Button>
          <Button type="button" size="sm" onClick={() => void submit()} disabled={!ready || busy}>
            {busy && <Loader2 className="animate-spin" />}
            {mode.kind === 'install'
              ? busy
                ? t('install.installing')
                : t('install.install')
              : busy
                ? t('installed.updating')
                : t('installed.update')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
