import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, RefreshCw, ShieldCheck } from 'lucide-react'
import type { BotSettingsView } from '../../../shared/bot'
import type { SettingsSection } from '@/components/settings/nav'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import { BotSteps, type BotStep } from './BotSteps'
import { BotServerCard } from './BotServerCard'
import { BotConnectGuide } from './BotConnectGuide'
import { BotRequestCard } from './BotRequestCard'
import { BotConnectionCard } from './BotConnectionCard'
import { approveRequestWithNewBot, type BotSetupDraft } from './setup-flow'
import {
  BOT_ACTION_NAMES,
  SUGGESTED_BOT_PERMISSION_CEILING,
  defaultServer,
  emptyBotSettings,
  endpointOf,
  type BotProviderOption,
  type BotWorkspaceOption,
  type ServerDraft,
} from './config'

interface Props {
  /** Move to another settings section, so a missing account is one click away from being connected. */
  onNavigate?: (section: SettingsSection) => void
  /** Open the project setup dialog, for when a bot cannot be authorized because there is no project. */
  onAddProject?: () => Promise<unknown> | void
}

/**
 * Bots, in the order the person actually walks them: publish this computer, add the connector inside
 * their own bot, then approve the request that arrives here and decide what it may use.
 */
export function BotSection({ onNavigate, onAddProject }: Props) {
  const { t } = useTranslation('ui')
  const [view, setView] = useState<BotSettingsView>(emptyBotSettings)
  const [workspaces, setWorkspaces] = useState<BotWorkspaceOption[]>([])
  const [providers, setProviders] = useState<BotProviderOption[]>([])
  // `null` mirrors the saved server configuration; any other value is an unsaved edit.
  const [draft, setDraft] = useState<ServerDraft | null>(null)
  // At most one waiting request is being set up at a time, and the draft names the request it belongs to.
  const [setup, setSetup] = useState<BotSetupDraft | null>(null)
  // A bot already created for a waiting request, so a failed approval is retried without minting another.
  const [created, setCreated] = useState<Record<string, string>>({})
  const [grants, setGrants] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editingWorkspaces, setEditingWorkspaces] = useState<string[]>([])

  const reload = useCallback(async () => {
    const [settings, projects, accounts] = await Promise.all([
      window.api.botSettings(),
      window.api.listWorkspaces(),
      window.api.platformExecutorProviders(),
    ])
    setView(settings)
    setWorkspaces(projects)
    setProviders(accounts)
  }, [])

  useEffect(() => {
    void reload().catch((caught) => setError(String(caught)))
  }, [reload])
  useEffect(() => {
    let mounted = true
    const timer = setInterval(() => {
      void window.api
        .botSettings()
        .then((value) => {
          if (mounted) setView(value)
        })
        .catch(() => {})
    }, 2_000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [])
  // A request that expired, or was answered elsewhere, takes its draft with it: nothing it collected may
  // ever be carried over to the next bot that happens to ask.
  useEffect(() => {
    const waiting = new Set(view.pendingAuthorizations.map((request) => request.id))
    if (setup && !waiting.has(setup.requestId)) {
      setSetup(null)
      setError(t('bots.requestGone'))
    }
    setCreated((current) => {
      const kept = Object.entries(current).filter(([requestId]) => waiting.has(requestId))
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
    })
  }, [view.pendingAuthorizations, setup, t])

  async function perform(action: () => Promise<void>) {
    setError('')
    setBusy(true)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const server = view.server
  const config: ServerDraft = draft ?? {
    enabled: server.enabled,
    host: server.host,
    port: server.port,
    publicUrl: server.publicUrl,
  }
  const endpoint = endpointOf(config)
  const pending = view.pendingAuthorizations
  // A connection saved by the relay release holds no authorization here, so it can only be reconnected.
  const grantable = view.connections.filter((connection) => !connection.revokedAt && !connection.legacy)
  const live = grantable.length > 0
  const listening = server.state === 'listening'
  const stepStates: Array<BotStep['id']> = ['publish', 'connect', 'approve']
  const reached: Record<BotStep['id'], boolean> = {
    publish: listening,
    connect: live || pending.length > 0,
    approve: live,
  }
  // A later step never claims to be done while an earlier one is still missing: the endpoint has to be
  // published before anything a bot did with it counts as working.
  let blocked = false
  const done = {} as Record<BotStep['id'], boolean>
  for (const id of stepStates) {
    blocked = blocked || !reached[id]
    done[id] = !blocked
  }
  const first = stepStates.find((id) => !done[id])
  const steps: BotStep[] = stepStates.map((id) => ({
    id,
    title: t(`bots.steps.${id}.title`),
    hint: t(`bots.steps.${id}.hint`),
    state: done[id] ? 'done' : id === first ? 'current' : 'todo',
  }))

  const copy = (key: string, text: string) =>
    void perform(async () => {
      await navigator.clipboard.writeText(text)
      setCopied(key)
    })
  const answer = (requestId: string, approved: boolean, connectionId: string) =>
    void perform(async () => {
      // The person answered this request here, so its setup is closed rather than reported as lost.
      setSetup((current) => (current?.requestId === requestId ? null : current))
      setView(await window.api.botAuthorize(requestId, approved, connectionId))
      await reload()
    })
  const submit = (requestId: string, current: BotSetupDraft, mintedId: string) =>
    void perform(async () => {
      const outcome = await approveRequestWithNewBot({
        api: {
          settings: () => window.api.botSettings(),
          connect: (input) => window.api.botConnect(input),
          authorize: (id, approved, connectionId) => window.api.botAuthorize(id, approved, connectionId),
        },
        draft: current,
        ...(mintedId ? { createdConnectionId: mintedId } : {}),
        messages: { requestGone: t('bots.requestGone'), createFailed: t('bots.createFailed') },
        onView: setView,
        // Tie the bot to this request, so a failed approval is retried with that same bot.
        onCreated: (connectionId) => setCreated((entries) => ({ ...entries, [requestId]: connectionId })),
      })
      setSetup(null)
      setView(outcome.view)
      await reload()
    })

  return (
    <section className="space-y-6" data-testid="bot-settings">
      <header className="flex items-start gap-3">
        <span className="rounded-xl border border-sky-400/20 bg-sky-400/[0.08] p-2.5 text-sky-300">
          <Bot className="size-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold">{t('bots.title')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('bots.description')}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto shrink-0"
          title={t('bots.refresh')}
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              setView(await window.api.botRefresh())
              await reload()
            })
          }
        >
          <RefreshCw className="size-4" />
        </Button>
      </header>

      <BotSteps steps={steps} />

      {(error || view.error || server.error) && (
        <p
          role="alert"
          className="rounded-md border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"
        >
          {error || view.error || server.error}
        </p>
      )}

      <BotServerCard
        config={config}
        state={server.state}
        dirty={!!draft}
        busy={busy}
        copied={copied === 'endpoint'}
        onEdit={(patch) => setDraft({ ...config, ...patch })}
        onDiscard={() => setDraft(null)}
        onCopy={(address) => copy('endpoint', address)}
        onSave={() =>
          void perform(async () => {
            await window.api.botConfigureServer({
              enabled: config.enabled,
              host: config.host.trim() || defaultServer.host,
              port: config.port,
              publicUrl: config.publicUrl.trim(),
            })
            setDraft(null)
            await reload()
          })
        }
      />

      <BotConnectGuide
        endpoint={endpoint}
        ready={listening}
        busy={busy}
        copied={copied === 'message'}
        onCopy={(message) => copy('message', message)}
      />

      <div
        className={cn('space-y-4 rounded-xl border p-4', pending.length ? 'border-sky-400/40' : 'border-border')}
        data-testid="bot-pending-authorizations"
      >
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="size-4 text-muted-foreground" />
          {t('bots.pendingTitle')}
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('bots.pendingDescription')}</p>
        {pending.length ? (
          pending.map((request) => {
            const current = setup?.requestId === request.id ? setup : null
            const mintedId = created[request.id] ?? ''
            const minted = view.connections.find((connection) => connection.id === mintedId)
            return (
              <BotRequestCard
                key={request.id}
                request={request}
                setup={current}
                mintedName={minted?.name ?? null}
                workspaces={workspaces}
                providers={providers}
                grantable={grantable}
                chosen={grants[request.id] ?? grantable[0]?.id ?? ''}
                busy={busy}
                onOpenSetup={() => {
                  setError('')
                  setSetup({
                    requestId: request.id,
                    name: request.clientName.slice(0, 160),
                    // Access is never pre-granted: every project and model is chosen by the person.
                    workspaceIds: [],
                    selections: [],
                    actions: [...BOT_ACTION_NAMES],
                    permissionCeiling: SUGGESTED_BOT_PERMISSION_CEILING,
                  })
                }}
                onCancelSetup={() => setSetup(null)}
                onEditSetup={(patch) => setSetup((value) => (value ? { ...value, ...patch } : value))}
                onSubmit={() => current && submit(request.id, current, mintedId)}
                onDeny={() => answer(request.id, false, '')}
                onReuse={(connectionId) => answer(request.id, true, connectionId)}
                onChoose={(connectionId) => setGrants({ ...grants, [request.id]: connectionId })}
                {...(onAddProject
                  ? {
                      onAddProject: () =>
                        void perform(async () => {
                          await onAddProject()
                          await reload()
                        }),
                    }
                  : {})}
                {...(onNavigate ? { onOpenChatSettings: () => onNavigate('chat') } : {})}
              />
            )
          })
        ) : (
          <p data-testid="bot-pending-empty" className="text-xs text-muted-foreground">
            {t('bots.pendingEmpty')}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-medium text-muted-foreground">{t('bots.connections')}</h3>
        {!view.connections.length && <p className="text-xs text-muted-foreground">{t('bots.empty')}</p>}
        {view.connections.map((connection) => (
          <BotConnectionCard
            key={connection.id}
            connection={connection}
            hostState={view.state}
            workspaces={workspaces}
            busy={busy}
            copied={copied === connection.id}
            editing={editing === connection.id}
            editingWorkspaces={editingWorkspaces}
            onCopy={(text) => copy(connection.id, text)}
            onToggleEditing={() => {
              setEditing(editing === connection.id ? null : connection.id)
              setEditingWorkspaces(connection.workspaceIds)
            }}
            onEditWorkspaces={setEditingWorkspaces}
            onSaveWorkspaces={() =>
              void perform(async () => {
                setView(await window.api.botUpdateWorkspaces(connection.id, editingWorkspaces))
                setEditing(null)
              })
            }
            onSetPermissionCeiling={(ceiling) =>
              void perform(async () => {
                setView(await window.api.botSetPermissionCeiling(connection.id, ceiling))
              })
            }
            onRevoke={() =>
              void perform(async () => {
                setView(await window.api.botRevoke(connection.id))
              })
            }
          />
        ))}
      </div>
    </section>
  )
}
