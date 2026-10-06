import { ExecutorSection } from './ExecutorSection'
import { ProjectBindingSection } from './ProjectBindingSection'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Link2, Server, Unplug } from 'lucide-react'
import type { DeviceAuthorizationView, PlatformConnectionView } from '../../../shared/platform'
import { Button } from '../ui/button'

export function PlatformSection() {
  const { i18n } = useTranslation()
  const L = (en: string, pt: string) => (i18n.language.startsWith('pt') ? pt : en)
  const [connections, setConnections] = useState<PlatformConnectionView[]>([])
  const [url, setUrl] = useState('http://127.0.0.1:14310')
  const [clientId, setClientId] = useState('')
  const [authorization, setAuthorization] = useState<DeviceAuthorizationView | null>(null)
  const [error, setError] = useState('')
  const reload = () => window.api.platformListConnections().then(setConnections)
  useEffect(() => {
    void reload()
  }, [])

  useEffect(() => {
    if (!authorization) return
    let active = true,
      pending = false
    const timer = setInterval(() => {
      if (pending) return
      pending = true
      void window.api
        .platformPollDeviceAuthorization(authorization.connectionId)
        .then((result) => {
          if (active && result.state === 'connected') {
            setAuthorization(null)
            void reload()
          }
        })
        .catch((e) => {
          if (active) {
            setError(e.message)
            setAuthorization(null)
          }
        })
        .finally(() => {
          pending = false
        })
    }, authorization.interval * 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [authorization])
  async function add() {
    setError('')
    try {
      await window.api.platformAddConnection(url)
      await reload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }
  async function authorize(connectionId: string) {
    const connection = connections.find((c) => c.id === connectionId)
    if (!clientId.trim() && !connection?.desktopClientId) {
      setError('Enter the public OAuth client ID registered by this installation.')
      return
    }
    const pending = await window.api.platformBeginDeviceAuthorization(connectionId, clientId.trim())
    setAuthorization(pending)
    await window.api.openExternalUrl(pending.verificationUriComplete ?? pending.verificationUri)
  }
  async function poll() {
    if (!authorization) return
    const result = await window.api.platformPollDeviceAuthorization(authorization.connectionId)
    if (result.state === 'connected') setAuthorization(null)
    await reload()
  }
  return (
    <section className="space-y-4">
      <header className="flex items-center gap-3">
        <Server className="size-5 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-semibold">{L('Kanban connection', 'Conexão com o Kanban')}</h2>
          <p className="text-xs text-muted-foreground">
            {L(
              'Connect this app to your Kanban, choose a project folder, then enable the executor below.',
              'Conecte este app ao seu Kanban, escolha a pasta do projeto e ative o executor abaixo.'
            )}
          </p>
        </div>
      </header>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-label={L('Instance URL', 'URL da instância')}
        />
        <Button onClick={() => void add()}>
          <Link2 className="size-4" /> {L('Add instance', 'Adicionar instância')}
        </Button>
      </div>
      {connections.length > 0 && !connections.some((c) => c.desktopClientId) ? (
        <details>
          <summary className="text-xs">
            {L('Advanced connection settings', 'Configurações avançadas de conexão')}
          </summary>
          <input
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="Public OAuth client ID for this instance"
            aria-label="OAuth client ID"
          />
        </details>
      ) : null}
      <div className="space-y-2">
        {connections.map((connection) => (
          <article key={connection.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
            <span
              className={`size-2 rounded-full ${connection.state === 'connected' ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
            />
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-sm">{connection.name}</strong>
              <span className="block truncate text-xs text-muted-foreground">
                {connection.url} · {connection.state}
                {connection.credentialPersistence === 'memory' ? ' · token held in memory only' : ''}
              </span>
            </div>
            {connection.state === 'connected' ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void window.api.platformDisconnect(connection.id).then(reload)}
                title={L('Disconnect', 'Desconectar')}
              >
                <Unplug className="size-4" />
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void authorize(connection.id)}>
                <ExternalLink className="size-4" /> {L('Connect', 'Conectar')}
              </Button>
            )}
          </article>
        ))}
      </div>
      {authorization ? (
        <div className="rounded-xl border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground">
            {L('Confirm this exact code in your browser', 'Confirme este código no navegador')}
          </p>
          <strong className="my-2 block font-mono text-xl tracking-widest">{authorization.userCode}</strong>
          <Button onClick={() => void poll()}>{L('I approved the code', 'Aprovei o código')}</Button>
        </div>
      ) : null}
      <ProjectBindingSection connections={connections} />
      <ExecutorSection connections={connections} />
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
