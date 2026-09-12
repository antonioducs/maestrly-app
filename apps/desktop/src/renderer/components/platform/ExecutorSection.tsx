import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Pause, Settings2, MessageSquare } from 'lucide-react'
import { Button } from '../ui/button'
import { useSettings } from '../../lib/use-settings'
import type {
  DesktopExecutorSettings,
  DesktopExecutionRecord,
  EmbeddedRunnerView,
  PlatformConnectionView,
} from '../../../shared/platform'
export function ExecutorSection({ connections }: { connections: PlatformConnectionView[] }) {
  const { i18n } = useTranslation(),
    { openSettings } = useSettings(),
    L = (en: string, pt: string) => (i18n.language.startsWith('pt') ? pt : en)
  const [settings, setSettings] = useState<DesktopExecutorSettings | null>(null),
    [providers, setProviders] = useState<Array<{ id: string; name: string; models: string[] }>>([]),
    [history, setHistory] = useState<DesktopExecutionRecord[]>([]),
    [status, setStatus] = useState<EmbeddedRunnerView>({ state: 'stopped' }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void window.api.platformExecutorSettings().then((v) => {
      if (active) setSettings(v)
    })
    void window.api
      .platformExecutorProviders()
      .then((v) => {
        if (active) setProviders(v)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    const refresh = () => {
      void window.api.platformRunnerStatus().then((v) => {
        if (active) setStatus(v)
      })
      void window.api.platformExecutorHistory().then((v) => {
        if (active) setHistory(v)
      })
    }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])
  async function act(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!settings)
    return <p className="text-xs text-muted-foreground">{L('Loading executor…', 'Carregando executor…')}</p>
  const active = status.state === 'running' || status.state === 'starting'
  const connection =
    connections.find((c) => c.id === settings.connectionId && c.state === 'connected') ??
    connections.find((c) => c.state === 'connected')
  const stateLabel = (value: string) =>
    ({
      running: L('Running', 'Em execução'),
      starting: L('Starting', 'Iniciando'),
      stopped: L('Paused', 'Pausado'),
      error: L('Error', 'Erro'),
      succeeded: L('Completed', 'Concluído'),
      failed: L('Failed', 'Falhou'),
      cancelled: L('Cancelled', 'Cancelado'),
    })[value] ?? value
  const controls: Array<[keyof DesktopExecutorSettings, string, string]> = [
    ['interactiveChat', 'Interactive project chat in the web', 'Chat interativo do projeto na web'],
    ['allowCommands', 'Run commands on this machine', 'Executar comandos nesta máquina'],
    ['allowAppTools', 'App tools: browser, terminal and notes', 'Ferramentas do app: browser, terminal e notas'],
    ['allowWeb', 'Web and browser access', 'Acessar web e browser'],
    ['allowMcp', 'Enabled MCP servers', 'Servidores MCP habilitados'],
    ['allowPush', 'Allow Git push commands', 'Permitir comandos de Git push'],
    ['skills', 'Configured project and global skills', 'Skills configuradas do projeto e globais'],
  ]
  return (
    <section className="space-y-4 rounded-xl border border-border p-4">
      <div>
        <h3 className="text-sm font-semibold">{L('Maestrly executor', 'Executor Maestrly')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {L(
            'Full chat engine, connected accounts and persistent conversations. Jobs run without interactive questions or plan approvals.',
            'Motor completo de chat, contas conectadas e conversas persistentes. Os jobs executam sem perguntas interativas ou aprovação de planos.'
          )}
        </p>
      </div>
      <fieldset disabled={active || busy} className="space-y-4">
        {connections.filter((c) => c.state === 'connected').length > 1 ? (
          <label className="block text-xs">
            {L('Kanban connection', 'Conexão com o Kanban')}
            <OptionSelect
              value={connection?.id ?? ''}
              onValueChange={(selectedValue) => setSettings({ ...settings, connectionId: selectedValue })}
            >
              {connections
                .filter((c) => c.state === 'connected')
                .map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    {c.name}
                  </SelectOption>
                ))}
            </OptionSelect>
          </label>
        ) : null}
        <label className="block text-xs">
          {L('Who can request work?', 'Quem pode solicitar trabalho?')}
          <OptionSelect
            className="mt-2 h-8 text-xs"
            value={settings.mode}
            onValueChange={(selectedValue) => setSettings({ ...settings, mode: selectedValue as 'personal' | 'team' })}
          >
            <SelectOption value="personal">{L('Only me — personal computer', 'Só eu — computador pessoal')}</SelectOption>
            <SelectOption value="team">
              {L('Approved projects — team executor', 'Projetos autorizados — executor da equipe')}
            </SelectOption>
          </OptionSelect>
        </label>
        <div>
          <p className="text-xs font-medium">{L('Available accounts', 'Contas disponibilizadas')}</p>
          <div className="mt-2 space-y-2">
            {providers.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={settings.providerIds.includes(p.id)}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      providerIds: e.target.checked
                        ? [...settings.providerIds, p.id]
                        : settings.providerIds.filter((id) => id !== p.id),
                    })
                  }
                />
                <span>
                  {p.name} · {p.models.length} {L('models', 'modelos')}
                </span>
              </label>
            ))}
          </div>
          {!providers.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {L(
                'Connect an account in chat settings, then refresh.',
                'Conecte uma conta nas configurações do chat e atualize a lista.'
              )}
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => openSettings('chat')}>
            <Settings2 size={14} />
            {L('Accounts, skills and MCPs', 'Contas, skills e MCPs')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void act(async () => setProviders(await window.api.platformExecutorProviders()))}
          >
            {L('Refresh accounts', 'Atualizar contas')}
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {controls.map(([key, en, pt]) => (
            <label className="flex gap-2 text-xs" key={key}>
              <input
                type="checkbox"
                checked={settings[key] === true}
                onChange={(e) => setSettings({ ...settings, [key]: e.target.checked })}
              />
              {L(en, pt)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {L(
            'Commands and enabled MCPs use this machine’s access. Authorize only projects and tools you trust. Execution workspaces are retained for inspection.',
            'Comandos e MCPs habilitados usam o acesso desta máquina. Autorize apenas projetos e ferramentas de confiança. Os workspaces das execuções são preservados para inspeção.'
          )}
        </p>
        <label className="flex gap-2 text-xs">
          <input
            type="checkbox"
            checked={settings.background}
            onChange={(e) => setSettings({ ...settings, background: e.target.checked })}
          />
          {L('Continue in background when the window is closed', 'Continuar em segundo plano ao fechar a janela')}
        </label>
        <label className="flex gap-2 text-xs">
          <input
            type="checkbox"
            checked={settings.autoStart}
            onChange={(e) => setSettings({ ...settings, autoStart: e.target.checked })}
          />
          {L('Start with macOS/Windows login', 'Iniciar ao entrar no macOS/Windows')}
        </label>
      </fieldset>
      <div className="flex items-center gap-2">
        <Button
          disabled={busy || (!active && (!connection || !settings.providerIds.length))}
          onClick={() =>
            void act(async () => {
              if (active) {
                await window.api.platformRunnerStop()
                setStatus({ state: 'stopped' })
              } else {
                await window.api.platformSaveExecutorSettings({ ...settings, connectionId: connection!.id })
                setStatus(await window.api.platformRunnerStart(connection!.id))
              }
            })
          }
        >
          {active ? <Pause size={15} /> : <Play size={15} />}{' '}
          {L(active ? 'Pause executor' : 'Start executor', active ? 'Pausar executor' : 'Iniciar executor')}
        </Button>
        <Button
          variant="outline"
          disabled={busy || active}
          onClick={() =>
            void act(async () => {
              setSettings(
                await window.api.platformSaveExecutorSettings({
                  ...settings,
                  ...(connection ? { connectionId: connection.id } : {}),
                })
              )
            })
          }
        >
          {L('Save settings', 'Salvar configuração')}
        </Button>
        <span className="text-xs text-muted-foreground">{stateLabel(status.state)}</span>
      </div>
      {status.error || error ? (
        <p className="text-xs text-destructive" role="alert">
          {error || status.error}
        </p>
      ) : null}
      {history.length ? (
        <div className="space-y-2 border-t border-border pt-3">
          <h4 className="text-xs font-medium">{L('Execution conversations', 'Conversas das execuções')}</h4>
          {history.slice(0, 20).map((run) => (
            <button
              key={run.runId}
              className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-muted"
              onClick={() => void act(() => window.api.platformOpenExecutorConversation(run.conversationId))}
            >
              <MessageSquare size={15} />
              <span className="min-w-0 flex-1 truncate text-xs">{run.title}</span>
              <span className="text-[10px] text-muted-foreground">{stateLabel(run.state)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}
