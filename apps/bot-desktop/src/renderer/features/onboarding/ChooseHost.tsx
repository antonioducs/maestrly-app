import { useState } from 'react'
import { Button, Input } from '../../ui'
import { useT } from '../../i18n'
import type { HostTarget } from '../../../shared/types'
export function ChooseHost({ connect, refreshHosts, onChosen }: { connect: (target: HostTarget) => Promise<void>; refreshHosts: () => Promise<void>; onChosen: (id: string) => void }) {
  const t = useT()
  const [place, setPlace] = useState<'local' | 'ssh'>()
  const [alias, setAlias] = useState('')
  const [missing, setMissing] = useState(false)
  const [outcome, setOutcome] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action() } catch (error) { setError(String(error)) } finally { setBusy(false) } }
  return (
      <section className="onboarding">
        <h1>{t('destination')}</h1>
        <div className="actions">
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setPlace('local')
                setOutcome('')
                const status = await window.bot.localHost()
                if (status.state === 'installed') {
                  const target: HostTarget = { kind: 'local', id: 'local', displayName: t('here') }
                  await connect(target)
                  await refreshHosts()
                  onChosen('local')
                } else if (status.state === 'missing') setMissing(true)
                else setOutcome(status.reason)
              })
            }
          >
            {t('here')}
          </Button>
          <Button
            onClick={() => {
              setPlace('ssh')
              setOutcome('')
            }}
          >
            {t('elsewhere')}
          </Button>
        </div>
        {place === 'local' && missing && (
          <>
            <p>{t('missingHost')}</p>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await window.bot.installLocalHost()
                  setOutcome(result.message)
                  if (result.status === 'installed') {
                    await connect({ kind: 'local', id: 'local', displayName: t('here') })
                    await refreshHosts()
                    onChosen('local')
                  }
                })
              }
            >
              {t('installHost')}
            </Button>
          </>
        )}
        {place === 'ssh' && (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                const target = await window.bot.addSshTarget(alias)
                await connect(target)
                await refreshHosts()
                onChosen(target.id)
              })
            }}
          >
            <label>
              {t('alias')}
              <Input value={alias} onChange={(event) => setAlias(event.target.value)} required />
            </label>
            <p>{t('trustedKey')}</p>
            <Button disabled={busy}>{t('addComputer')}</Button>
          </form>
        )}
        {outcome && <p role="status">{outcome}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
    )
}
