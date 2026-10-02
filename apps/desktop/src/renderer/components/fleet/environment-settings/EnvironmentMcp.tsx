import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetSettingsOutput } from '@maestrly/bot-fleet-protocol'
import { requestMainNavigation } from '@/lib/main-navigation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { emptyMcpDraft, mcpCreateInput, mcpPatchInput } from '@/components/chat/mcp-settings-source'
import {
  useEnvironmentSettingsResource,
  useEnvironmentSettingsSource,
  useSettingsLifetime,
} from '@/lib/fleet/environment-settings'
import { SettingsSwitch } from '../SettingsSwitch'
import {
  SaveDiscard,
  SettingsPanel,
  settingsInput,
  useSettingsDraft,
  type EnvironmentSettingsSectionProps,
} from './shared'
type Server = FleetSettingsOutput<'mcpServer'>
export function EnvironmentMcp(props: EnvironmentSettingsSectionProps) {
  return <McpPanel key={props.environment.id} {...props} />
}
function McpPanel({ environment, fleet, onDirtyChange }: EnvironmentSettingsSectionProps) {
  const { t } = useTranslation('fleet')
  const resource = useEnvironmentSettingsResource(environment.id, 'mcpServers')
  const [editing, setEditing] = useState<Server | 'new' | null>(null)
  const [removing, setRemoving] = useState<Server | null>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, FleetSettingsOutput<'testMcpServer'>>>({})
  const online = fleet.state.connection.state === 'connected' && environment.lifecycle === 'running'
  const lifetime = useSettingsLifetime()
  async function act(action: () => Promise<unknown>) {
    if (!online || busy) return
    const epoch = lifetime.current
    setBusy(true)
    try {
      await action()
      if (epoch === lifetime.current) await resource.reload()
    } catch {
      if (epoch === lifetime.current) resource.setError(true)
    } finally {
      if (epoch === lifetime.current) setBusy(false)
    }
  }
  return (
    <SettingsPanel
      error={resource.error}
      loading={!resource.data && resource.busy}
      reload={() => void resource.reload()}
    >
      <p className="text-xs text-muted-foreground">{t('environmentSettings.mcpNote')}</p>
      {resource.data?.servers.map((server) => (
        <div key={server.id} className="space-y-1 rounded-lg border border-border bg-white/[0.025] px-3 py-2">
          <div className="flex items-center gap-2">
            <SettingsSwitch
              checked={server.enabled}
              disabled={busy || !!editing}
              label={t('environmentSettings.enabled', { name: server.name })}
              onChange={() =>
                void act(() =>
                  resource.source.patchMcpServer({
                    id: server.id,
                    expectedRevision: server.revision,
                    enabled: !server.enabled,
                  })
                )
              }
            />
            <span className="flex-1">
              {server.name}{' '}
              <span className="text-xs text-muted-foreground">
                {server.transport}
                {server.host ? ` · ${server.host}` : ''}
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !!editing}
              onClick={() =>
                void act(async () => {
                  const epoch = lifetime.current
                  const result = await resource.source.testMcpServer({ id: server.id })
                  if (epoch === lifetime.current) setResults((current) => ({ ...current, [server.id]: result }))
                })
              }
            >
              {t('environmentSettings.test')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || !!editing} onClick={() => setEditing(server)}>
              {t('environmentSettings.edit')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || !!editing} onClick={() => setRemoving(server)}>
              {t('environmentSettings.remove')}
            </Button>
          </div>
          {results[server.id] && (
            <p role="status" className="text-xs text-muted-foreground">
              {t(`environmentSettings.mcpTest.${results[server.id].code}`)} ·{' '}
              {t('environmentSettings.toolCount', { count: results[server.id].toolCount })}
            </p>
          )}
          {server.unavailable && (
            <p className="text-xs text-muted-foreground">{t('environmentSettings.mcpTest.unavailable')}</p>
          )}
        </div>
      ))}
      {!editing && (
        <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
          {t('environmentSettings.addServer')}
        </Button>
      )}
      {editing && (
        <McpEditor
          online={online}
          environmentId={environment.id}
          server={editing === 'new' ? null : (resource.data?.servers.find((s) => s.id === editing.id) ?? editing)}
          onDirtyChange={onDirtyChange}
          onDone={() => {
            setEditing(null)
            void resource.reload()
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={t('environmentSettings.remove')}
          message={t('environmentSettings.removeServer', { name: removing.name })}
          confirmLabel={t('environmentSettings.remove')}
          destructive
          busy={busy}
          error={resource.error ? t('environmentSettings.failed') : null}
          onCancel={() => setRemoving(null)}
          onConfirm={() =>
            void act(async () => {
              await resource.source.removeMcpServer({ id: removing.id, expectedRevision: removing.revision })
              setRemoving(null)
            })
          }
        />
      )}
    </SettingsPanel>
  )
}
function McpEditor({
  environmentId,
  server,
  onDirtyChange,
  onDone,
  online,
}: {
  environmentId: string
  server: Server | null
  onDirtyChange: EnvironmentSettingsSectionProps['onDirtyChange']
  online: boolean
  onDone: () => void
}) {
  const { t } = useTranslation('fleet')
  const source = useEnvironmentSettingsSource(environmentId)
  const savedServer = useRef(server)
  const editor = useSettingsDraft(
    {
      ...emptyMcpDraft(),
      ...(server ? { name: server.name, transport: server.transport, enabled: server.enabled } : {}),
    },
    async (draft) => {
      if (!online) throw new Error('Environment offline')
      const current = savedServer.current
      savedServer.current = current
        ? await source.patchMcpServer(mcpPatchInput(current.id, current.revision, draft, current.transport))
        : await source.createMcpServer(mcpCreateInput(draft))
    },
    onDirtyChange,
    server?.revision
  )
  useEffect(() => {
    if (!editor.dirty) savedServer.current = server
  }, [server?.revision])
  const save = async () => {
    const ok = await editor.save()
    if (ok) {
      onDirtyChange?.(
        false,
        async () => true,
        () => {}
      )
      onDone()
    }
    return ok
  }
  const close = () => {
    editor.discard()
    onDirtyChange?.(
      false,
      async () => true,
      () => {}
    )
    onDone()
  }
  const fields =
    editor.draft.transport === 'http' ? (['url', 'headers'] as const) : (['command', 'args', 'env'] as const)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !editor.busy) requestMainNavigation(close)
      }}
    >
      <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>{t('environmentSettings.editServer')}</DialogTitle>
          <DialogDescription>{t('environmentSettings.preserveSecret')}</DialogDescription>
        </DialogHeader>
        <SettingsPanel error={editor.error} reload={close}>
          <label className="block space-y-1">
            {t('environmentSettings.name')}
            <input
              className={settingsInput}
              disabled={editor.busy || !online}
              value={editor.draft.name}
              onChange={(e) => editor.setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </label>
          <Select
            value={editor.draft.transport}
            disabled={editor.busy || !online}
            onValueChange={(value) => editor.setDraft((d) => ({ ...d, transport: value as 'http' | 'stdio' }))}
          >
            <SelectTrigger aria-label={t('environmentSettings.transport')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">HTTP</SelectItem>
              <SelectItem value="stdio">stdio</SelectItem>
            </SelectContent>
          </Select>
          {fields.map((field) => (
            <label key={field} className="block space-y-1">
              {t(`environmentSettings.mcpField.${field}`)}
              {field === 'env' || field === 'headers' || field === 'args' ? (
                <textarea
                  className={settingsInput}
                  disabled={editor.busy || !online}
                  value={editor.draft[field]}
                  onChange={(e) => editor.setDraft((d) => ({ ...d, [field]: e.target.value }))}
                  rows={3}
                  spellCheck={false}
                />
              ) : (
                <input
                  type="password"
                  autoComplete="new-password"
                  className={settingsInput}
                  disabled={editor.busy || !online}
                  value={editor.draft[field]}
                  onChange={(e) => editor.setDraft((d) => ({ ...d, [field]: e.target.value }))}
                />
              )}
            </label>
          ))}
          {server &&
            (editor.draft.transport === 'http' ? (['headers'] as const) : (['env'] as const)).map((kind) => (
              <div key={kind}>
                {(kind === 'env' ? server.envKeys : server.headerKeys).map((key) => {
                  const field = kind === 'env' ? 'removeEnv' : 'removeHeaders'
                  return (
                    <label key={key} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        disabled={editor.busy || !online}
                        checked={editor.draft[field].includes(key)}
                        onChange={(e) =>
                          editor.setDraft((d) => ({
                            ...d,
                            [field]: e.target.checked ? [...d[field], key] : d[field].filter((item) => item !== key),
                          }))
                        }
                      />
                      {t('environmentSettings.removeSecret', { key })}
                    </label>
                  )
                })}
              </div>
            ))}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <SaveDiscard {...editor} busy={editor.busy || !online} save={save} discard={close} />
            <Button size="sm" variant="ghost" disabled={editor.busy} onClick={() => requestMainNavigation(close)}>
              {t('environmentSettings.close')}
            </Button>
          </div>
        </SettingsPanel>
      </DialogContent>
    </Dialog>
  )
}
