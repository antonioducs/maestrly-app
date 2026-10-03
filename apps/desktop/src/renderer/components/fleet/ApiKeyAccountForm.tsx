import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetApiKeyProviderKind } from '@maestrly/bot-fleet-protocol'
import type { FleetProvisioningTargetInput } from '../../../preload/api-fleet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/**
 * Adds an API key account to an environment (shared by its bots) or, before environments, to a bot. The key goes
 * from this form to the main process only: it is never kept in React state and the field is cleared once sent.
 */
export function ApiKeyAccountForm({
  target,
  onAdded,
  onDirtyChange,
}: {
  target: FleetProvisioningTargetInput
  onAdded: () => Promise<void>
  onDirtyChange?: (dirty: boolean, save: () => Promise<boolean>, discard: () => void) => void
}) {
  const { t } = useTranslation('fleet')
  const [accountKind, setAccountKind] = useState<FleetApiKeyProviderKind>('openai')
  const [accountName, setAccountName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const keyRef = useRef<HTMLInputElement>(null)
  const [keyEntered, setKeyEntered] = useState(false)
  const writing = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const latestSave = useRef<() => Promise<boolean>>(async () => false)
  const save = useCallback(() => latestSave.current(), [])
  const discard = useCallback(() => {
    setAccountKind('openai')
    setAccountName('')
    setBaseURL('')
    if (keyRef.current) keyRef.current.value = ''
    setKeyEntered(false)
    setError('')
  }, [])
  const dirty = !!accountName || !!baseURL || keyEntered || accountKind !== 'openai'
  useEffect(() => {
    onDirtyChange?.(dirty, save, discard)
  }, [dirty, accountName, baseURL, accountKind, save, discard, onDirtyChange])
  async function addAccount(): Promise<boolean> {
    const key = keyRef.current?.value ?? ''
    const name = accountName.trim()
    const url = baseURL.trim()
    if (writing.current) return false
    if (
      !name ||
      name.length > 40 ||
      !key.trim() ||
      key.length > 512 ||
      (url && (url.length > 300 || !/^https?:\/\//i.test(url) || !URL.canParse(url)))
    ) {
      setError(t('botSettings.accountInvalid'))
      return false
    }
    writing.current = true
    setBusy(true)
    setError('')
    try {
      await window.api.fleetAddApiKeyAccount(target, { kind: accountKind, name, key, baseURL: url || null })
      if (mounted.current) discard()
      await onAdded()
      return true
    } catch {
      if (mounted.current) setError(t('botSettings.accountAddFailed'))
      return false
    } finally {
      writing.current = false
      if (mounted.current) setBusy(false)
    }
  }
  latestSave.current = addAccount
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-elevated p-4">
      <h3 className="text-sm font-medium">{t('botSettings.addApiKey')}</h3>
      <label className="block text-xs" htmlFor="fleet-account-kind">
        {t('botSettings.providerKind')}
      </label>
      <Select
        disabled={busy}
        value={accountKind}
        onValueChange={(value) => setAccountKind(value as FleetApiKeyProviderKind)}
      >
        <SelectTrigger id="fleet-account-kind" aria-label={t('botSettings.providerKind')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="openai">{t('botSettings.kindOpenAI')}</SelectItem>
          <SelectItem value="openai-responses">{t('botSettings.kindResponses')}</SelectItem>
          <SelectItem value="anthropic">{t('botSettings.kindAnthropic')}</SelectItem>
        </SelectContent>
      </Select>
      <label className="block text-xs" htmlFor="fleet-account-name">
        {t('botSettings.accountName')}
      </label>
      <Input
        className="bg-surface-elevated"
        id="fleet-account-name"
        value={accountName}
        disabled={busy}
        maxLength={40}
        onChange={(event) => setAccountName(event.target.value)}
      />
      <label className="block text-xs" htmlFor="fleet-account-key">
        {t('botSettings.apiKey')}
      </label>
      <Input
        className="bg-surface-elevated"
        id="fleet-account-key"
        ref={keyRef}
        type="password"
        autoComplete="off"
        disabled={busy}
        onChange={(event) => setKeyEntered(!!event.target.value)}
        maxLength={512}
      />
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">{t('botSettings.advanced')}</summary>
        <label className="mt-3 block text-xs" htmlFor="fleet-account-url">
          {t('botSettings.baseURL')}
        </label>
        <Input
          className="bg-surface-elevated"
          id="fleet-account-url"
          value={baseURL}
          disabled={busy}
          maxLength={300}
          placeholder="https://api.example.com/v1"
          onChange={(event) => setBaseURL(event.target.value)}
        />
      </details>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button size="sm" disabled={busy} onClick={() => void addAccount()}>
        {t('botSettings.addAccount')}
      </Button>
    </div>
  )
}
