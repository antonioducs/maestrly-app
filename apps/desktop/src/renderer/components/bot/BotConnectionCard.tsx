import { useTranslation } from 'react-i18next'
import { Bot, Copy, ShieldCheck, Unplug } from 'lucide-react'
import type { BotConnectionView, BotPermissionCeiling, BotSettingsView } from '../../../shared/bot'
import { Button } from '../ui/button'
import { OptionSelect, SelectOption } from '../ui/option-select'
import { Pill, type PillTone } from './pill'
import { BOT_ACTION_NAMES, BOT_PERMISSION_CEILING_NAMES } from './config'
import type { BotWorkspaceOption } from './config'

interface Props {
  connection: BotConnectionView
  /** Whether the host is currently running this desktop's bots at all. */
  hostState: BotSettingsView['state']
  workspaces: BotWorkspaceOption[]
  busy: boolean
  copied: boolean
  editing: boolean
  editingWorkspaces: string[]
  onCopy: (text: string) => void
  onToggleEditing: () => void
  onEditWorkspaces: (workspaceIds: string[]) => void
  onSaveWorkspaces: () => void
  onSetPermissionCeiling: (ceiling: BotPermissionCeiling) => void
  onRevoke: () => void
}

const HOST_TONES: Record<BotSettingsView['state'], PillTone> = {
  connected: 'ok',
  connecting: 'warn',
  offline: 'off',
  stopped: 'off',
  error: 'danger',
}

/** One bot that already has access here: what it may use, and the ways to change or cut that access. */
export function BotConnectionCard(props: Props) {
  const { t } = useTranslation('ui')
  const { connection, workspaces, busy } = props
  const tone: PillTone = connection.revokedAt ? 'danger' : connection.legacy ? 'warn' : HOST_TONES[props.hostState]
  const label = connection.revokedAt
    ? t('bots.states.revoked')
    : connection.legacy
      ? t('bots.legacy')
      : t(`bots.connectionStates.${props.hostState}`)
  const projects = connection.workspaceIds.map((id) => workspaces.find((workspace) => workspace.id === id)?.name ?? id)

  return (
    <article
      data-testid="bot-connection"
      data-legacy={connection.legacy ? 'true' : 'false'}
      className="space-y-3 rounded-xl border border-border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="size-4 text-sky-300" />
        <h4 className="min-w-0 flex-1 truncate text-sm font-medium">{connection.name}</h4>
        <Pill tone={tone}>{label}</Pill>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {projects.length ? (
          projects.map((name) => (
            <span key={name} className="rounded-md bg-white/[0.06] px-2 py-1 text-[11px]">
              {name}
            </span>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">{t('bots.noAccess')}</span>
        )}
        {!connection.legacy &&
          BOT_ACTION_NAMES.filter((action) => connection.actions.includes(action)).map((action) => (
            <span key={action} className="rounded-md bg-white/[0.03] px-2 py-1 text-[11px] text-muted-foreground">
              {t(`bots.actions.${action.slice(6)}`)}
            </span>
          ))}
        {!connection.legacy && (
          <span
            data-testid="bot-connection-ceiling"
            data-ceiling={connection.permissionCeiling}
            className="inline-flex items-center gap-1 rounded-md bg-white/[0.03] px-2 py-1 text-[11px] text-muted-foreground"
          >
            <ShieldCheck className="size-3" />
            {t(`bots.ceiling.${connection.permissionCeiling}`)}
          </span>
        )}
      </div>

      {!connection.revokedAt && (
        <>
          {connection.legacy ? (
            // Nothing here is usable until it is connected again, so only revoking remains offered.
            <p className="text-xs leading-relaxed text-muted-foreground">{t('bots.legacyDescription')}</p>
          ) : (
            !connection.mcpConfig && (
              <p className="text-xs leading-relaxed text-muted-foreground">{t('bots.configNeedsAddress')}</p>
            )
          )}
          <div className="flex flex-wrap items-center gap-2">
            {!connection.legacy && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || !connection.mcpConfig}
                  onClick={() => props.onCopy(connection.mcpConfig)}
                >
                  <Copy className="size-3.5" />
                  {props.copied ? t('bots.copied') : t('bots.copy')}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={props.onToggleEditing}>
                  {t('bots.changeProjects')}
                </Button>
                <OptionSelect
                  aria-label={t('bots.ceiling.change')}
                  className="h-8 w-auto text-xs"
                  value={connection.permissionCeiling}
                  disabled={busy}
                  onValueChange={(value) => props.onSetPermissionCeiling(value as BotPermissionCeiling)}
                >
                  {BOT_PERMISSION_CEILING_NAMES.map((ceiling) => (
                    <SelectOption key={ceiling} value={ceiling}>
                      {t(`bots.ceiling.${ceiling}`)}
                    </SelectOption>
                  ))}
                </OptionSelect>
              </>
            )}
            <span className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-destructive"
              onClick={props.onRevoke}
            >
              <Unplug className="size-3.5" />
              {t('bots.revoke')}
            </Button>
          </div>
          {!connection.legacy && connection.mcpConfig && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">{t('bots.showConfig')}</summary>
              <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted/40 p-3 text-[11px]">
                {connection.mcpConfig}
              </pre>
            </details>
          )}
          {!connection.legacy && props.editing && (
            <div className="space-y-2 border-t border-border pt-3">
              {workspaces.map((workspace) => (
                <label key={workspace.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={props.editingWorkspaces.includes(workspace.id)}
                    onChange={() =>
                      props.onEditWorkspaces(
                        props.editingWorkspaces.includes(workspace.id)
                          ? props.editingWorkspaces.filter((value) => value !== workspace.id)
                          : [...props.editingWorkspaces, workspace.id]
                      )
                    }
                  />
                  {workspace.name}
                </label>
              ))}
              <Button type="button" size="sm" disabled={busy} onClick={props.onSaveWorkspaces}>
                {t('bots.saveProjects')}
              </Button>
            </div>
          )}
        </>
      )}
    </article>
  )
}
