import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  isPeerPort,
  PEER_DEFAULT_PORT,
  PEER_PORT_MIN,
  type PeerOverview,
  type PeerPortError,
} from '../../../../shared/peer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { acceptPeerOverview } from '@/lib/peer/use-peer-overview'

const ERROR_KEY: Record<PeerPortError, string> = {
  invalid: 'settings.computers.portErrors.invalid',
  'in-use': 'settings.computers.portErrors.inUse',
  failed: 'settings.computers.portErrors.failed',
}

/**
 * Settings → Computers → Advanced: the port the owner's other computers reach this one at. Empty keeps the default,
 * which moves to one of the next ports when another program holds it; a chosen port is used exactly.
 */
export function PeerPortSetting({ overview }: { overview: PeerOverview }) {
  const { t } = useTranslation('ui')
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(overview.chosenPort === null ? '' : String(overview.chosenPort))
  const [error, setError] = useState<{ code: PeerPortError; port: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const shown = open || overview.chosenPort !== null || !!overview.hostingError

  useEffect(() => {
    setText(overview.chosenPort === null ? '' : String(overview.chosenPort))
  }, [overview.chosenPort])

  const wanted = text.trim() === '' ? null : Number(text.trim())
  const changed = wanted !== overview.chosenPort

  const apply = async (port: number | null) => {
    if (port !== null && (!/^\d+$/.test(String(port)) || !isPeerPort(port)))
      return setError({ code: 'invalid', port: text.trim() })
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.peerSetPort(port)
      acceptPeerOverview(result.overview)
      if (result.error) setError({ code: result.error, port: String(port ?? PEER_DEFAULT_PORT) })
    } finally {
      setBusy(false)
    }
  }

  if (!shown)
    return (
      <Button
        variant="link"
        className="h-auto self-start px-0 text-xs text-muted-foreground"
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        {t('settings.computers.advanced')}
      </Button>
    )

  return (
    <div data-peer-port className="flex flex-col gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5">
      <form
        className="flex items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (changed) void apply(wanted)
        }}
      >
        <label htmlFor="peer-port" className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{t('settings.computers.portTitle')}</span>
          <span className="block text-[11px] leading-snug text-muted-foreground">
            {t('settings.computers.portDesc', { port: PEER_DEFAULT_PORT })}
          </span>
        </label>
        <Input
          id="peer-port"
          value={text}
          inputMode="numeric"
          maxLength={5}
          placeholder={String(PEER_DEFAULT_PORT)}
          disabled={busy || !overview.available}
          aria-invalid={!!error}
          aria-describedby="peer-port-help"
          onChange={(event) => {
            setText(event.target.value.replace(/\D/g, ''))
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setText(overview.chosenPort === null ? '' : String(overview.chosenPort))
          }}
          className="h-8 w-24 shrink-0 font-mono"
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !changed || !overview.available}>
          {busy && <Loader2 className="animate-spin" />}
          {t('settings.computers.portApply')}
        </Button>
      </form>
      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 p-2.5 text-xs text-destructive">
          {t(ERROR_KEY[error.code], { port: error.port, min: PEER_PORT_MIN })}
        </p>
      )}
      <p id="peer-port-help" className="text-[11px] leading-snug text-muted-foreground">
        {t('settings.computers.portHelp')}
      </p>
      {overview.chosenPort !== null && (
        <Button
          variant="link"
          className="h-auto self-start px-0 text-xs"
          disabled={busy}
          onClick={() => void apply(null)}
        >
          {t('settings.computers.portDefault', { port: PEER_DEFAULT_PORT })}
        </Button>
      )}
    </div>
  )
}
