import { Button, Input, Checkbox, Textarea } from '../../ui'
import { useEffect, useState } from 'react'
import type { SharedAccount, Bot, NetworkPolicy } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
import { BotFiles } from './BotFiles'
import { BotMemory } from './BotMemory'
import { BotSettings } from '../settings/BotSettings'
import { BotComputer } from './BotComputer'
const tabs = ['instructions', 'model', 'files', 'memory', 'permissions', 'internet'] as const
export function BotDetails({
  bot,
  advanced,
  onUpdate,
  onArchive,
  onPreview,
  onAccounts,
}: {
  bot: Bot
  advanced: boolean
  onUpdate: (bot: Bot) => void
  onArchive: () => void
  onPreview: (name: string, text: string) => void
  onAccounts: () => void
}) {
  const t = useT()
  const [tab, setTab] = useState<(typeof tabs)[number]>('instructions')
  const [name, setName] = useState(bot.name)
  const [purpose, setPurpose] = useState(bot.purpose)
  const [instructions, setInstructions] = useState(bot.instructions)
  const [account, setAccount] = useState<SharedAccount>()
  const [network, setNetwork] = useState<NetworkPolicy>()
  const [domain, setDomain] = useState('')
  const [full, setFull] = useState(false)
  const [archive, setArchive] = useState(false)
  const [error, setError] = useState('')
  const run = async (action: () => Promise<void>) => {
    setError('')
    try {
      await action()
    } catch (error) {
      setError(String(error))
      await window.bot
        .bot({ method: 'bot.inspect', params: { botId: bot.id } })
        .then(onUpdate)
        .catch(() => undefined)
    }
  }
  useEffect(() => {
    if (tab === 'model' && bot.accountId) void run(async () => setAccount(await window.bot.bot({ method: 'account.inspect', params: { accountId: bot.accountId } })))
    if (tab === 'internet')
      void run(async () =>
        setNetwork((await window.bot.bot({ method: 'bot.network.inspect', params: { botId: bot.id } })).policy)
      )
  }, [tab, bot.id, bot.accountId])
  const update = async (params: Record<string, unknown>) =>
    onUpdate(
      await window.bot.bot({
        method: 'bot.update',
        params: { botId: bot.id, expectedRevision: bot.revision, ...params },
      })
    )
  const updateNetwork = async (domains: string[], mode: 'offline' | 'allowlist' | 'blocklist' = network?.mode ?? 'blocklist') => {
    if (!network) return
    try {
      setNetwork(
        (
          await window.bot.bot({
            method: 'bot.network.update',
            params: {
              botId: bot.id,
              expectedRevision: network.revision,
              idempotencyKey: crypto.randomUUID(),
              mode,
              domains,
            },
          })
        ).policy
      )
    } catch (error) {
      setNetwork((await window.bot.bot({ method: 'bot.network.inspect', params: { botId: bot.id } })).policy)
      throw error
    }
  }
  return (
    <section>
      <BotComputer bot={bot} />
      <nav className="tabs" aria-label={t('details')}>
        {tabs.map((value) => (
          <Button
            key={value}
            aria-pressed={tab === value}
            onClick={() => {
              setTab(value)
            }}
          >
            {t(value)}
          </Button>
        ))}
      </nav>
      {tab === 'instructions' && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(() => update({ name, purpose, instructions }))
          }}
        >
          <label>
            {t('name')}
            <Input value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            {t('purpose')}
            <Textarea
              aria-label={t('purpose')}
              value={purpose}
              maxLength={4000}
              onChange={(event) => setPurpose(event.target.value)}
            />
          </label>
          <label>
            {t('instructions')}
            <Textarea
              aria-label={t('instructions')}
              value={instructions}
              maxLength={16000}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <Button>{t('save')}</Button>
        </form>
      )}
      {tab === 'model' && <>
        <p>{t('sharedAccount')}: <strong>{account?.status.account?.email ?? account?.name ?? (bot.accountId ? '—' : t('existingAccounts'))}</strong></p>
        <p>{t('accountReferenceExplanation')}</p>
        <BotSettings bot={bot} onUpdate={onUpdate} />
        <Button className="text-button" onClick={onAccounts}>{t('manageAccounts')}</Button>
      </>}
      {tab === 'files' && <BotFiles botId={bot.id} onPreview={onPreview} />}
      {tab === 'memory' && <BotMemory botId={bot.id} />}
      {tab === 'permissions' && (
        <>
          <p>{t(bot.permissionMode === 'ask' ? 'askMode' : 'fullMode')}</p>
          <p className="permission-note">{t('elevationUnavailable')}</p>
          {bot.permissionMode === 'full-vm' ? (
            <Button onClick={() => void run(() => update({ permissionMode: 'ask' }))}>{t('restoreAsk')}</Button>
          ) : (
            <details className="danger">
              <summary>{t('fullMode')}</summary>
              <p>{t('fullWarning')}</p>
              <label className="check">
                <Checkbox checked={full} onChange={(event) => setFull(event.target.checked)} />
                {t('confirmFull')}
              </label>
              <Button
                disabled={!full}
                onClick={() => void run(() => update({ permissionMode: 'full-vm', confirmFullVm: true }))}
              >
                {t('enableFull')}
              </Button>
            </details>
          )}
        </>
      )}
      {tab === 'internet' && network && (
        <>
          <p>{t(network.mode === 'blocklist' ? 'publicInternet' : network.mode === 'offline' ? 'internetOff' : 'legacyInternet')}</p>
          <p>{t('publicInternetAccess')}</p>
          {network.mode !== 'blocklist' && <Button onClick={() => void run(() => updateNetwork(network.mode === 'offline' ? network.domains : [], 'blocklist'))}>{t('enablePublicInternet')}</Button>}
          <h3>{t(network.mode === 'allowlist' ? 'internetLimited' : 'blockedSites')}</h3>
          {network.mode !== 'allowlist' && <p>{t('blockedSubdomains')}</p>}
          <ul>
            {network.domains.map((value) => (
              <li key={value}>
                {value}{' '}
                <Button
                  aria-label={`${t('remove')} ${value}`}
                  onClick={() => void run(() => updateNetwork(network.domains.filter((entry) => entry !== value)))}
                >
                  {t('remove')}
                </Button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await updateNetwork([...new Set([...network.domains, domain.toLowerCase()])])
                setDomain('')
              })
            }}
          >
            <label>
              {t(network.mode === 'allowlist' ? 'domain' : 'blockedDomain')}
              <Input
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                required
                pattern="[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+"
              />
            </label>
            <Button>{t('add')}</Button>
          </form>
          <Button onClick={() => void run(() => updateNetwork(network.mode === 'allowlist' ? [] : network.domains, 'offline'))}>{t('offline')}</Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <footer>
        <Button className="danger" onClick={() => setArchive(true)}>
          {t('archive')}
        </Button>
      </footer>
      {archive && (
        <dialog
          ref={(node) => {
            if (node && !node.open) node.showModal()
          }}
          aria-labelledby="archive-title"
          onCancel={() => setArchive(false)}
        >
          <h2 id="archive-title">{t('archive')}</h2>
          <p>{t('archiveWarning')}</p>
          <Button onClick={() => setArchive(false)}>{t('cancel')}</Button>
          <Button
            className="danger"
            onClick={() =>
              void run(async () => {
                await window.bot.bot({
                  method: 'bot.archive',
                  params: { botId: bot.id, expectedRevision: bot.revision, idempotencyKey: crypto.randomUUID() },
                })
                onArchive()
              })
            }
          >
            {t('confirmArchive')}
          </Button>
        </dialog>
      )}
    </section>
  )
}
