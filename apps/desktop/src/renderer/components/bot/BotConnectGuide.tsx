import { useTranslation } from 'react-i18next'
import { Copy, Plug } from 'lucide-react'
import { Button } from '../ui/button'
import { Pill } from './pill'

interface Props {
  endpoint: string
  /** The endpoint is published and listening, so the address in the message can actually be reached. */
  ready: boolean
  busy: boolean
  copied: boolean
  onCopy: (message: string) => void
}

/**
 * How a bot is added, in the words of the app the person is actually using. The connector is created
 * inside their own bot, and the authorization is finished here; nothing in this flow goes through a
 * website, so the screen never sends them somewhere they do not need to go.
 */
export function BotConnectGuide({ endpoint, ready, busy, copied, onCopy }: Props) {
  const { t } = useTranslation('ui')
  const message = t('bots.grokGuide.message', { endpoint })

  return (
    <section className="space-y-4 rounded-xl border border-border p-4" data-testid="bot-grok-guide">
      <div className="flex flex-wrap items-center gap-2">
        <Plug className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t('bots.grokGuide.title')}</h3>
        {!ready && <Pill tone="warn">{t('bots.grokGuide.needsAddress')}</Pill>}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('bots.grokGuide.intro')}</p>

      <ol className="space-y-4">
        <li className="flex gap-3">
          <Step index={1} />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs leading-relaxed">{t('bots.grokGuide.ask')}</p>
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border-strong bg-black/20 p-3">
              <span data-testid="bot-grok-message" className="min-w-0 flex-1 select-all break-all text-xs italic">
                {message}
              </span>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onCopy(message)}>
                <Copy className="size-3.5" />
                {copied ? t('bots.copied') : t('bots.grokGuide.copyMessage')}
              </Button>
            </div>
          </div>
        </li>
        <li className="flex gap-3">
          <Step index={2} />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs leading-relaxed">{t('bots.grokGuide.authorize')}</p>
            <div
              aria-hidden="true"
              className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/30 p-2.5 text-xs"
            >
              <span className="flex size-7 items-center justify-center rounded-md bg-white/[0.06] font-semibold">
                M
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Maestrly</span>
                <span className="block text-[11px] text-muted-foreground">MCP</span>
              </span>
              <Pill tone="warn">{t('bots.grokGuide.cardBadge')}</Pill>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('bots.grokGuide.noPassword')}</p>
          </div>
        </li>
        <li className="flex gap-3">
          <Step index={3} />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs leading-relaxed">{t('bots.grokGuide.approveHere')}</p>
            <p className="rounded-md bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
              {t('bots.grokGuide.prompt')}
            </p>
          </div>
        </li>
      </ol>
    </section>
  )
}

function Step({ index }: { index: number }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[11px] font-semibold">
      {index}
    </span>
  )
}
