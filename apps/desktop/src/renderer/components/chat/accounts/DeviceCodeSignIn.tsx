import { useTranslation } from 'react-i18next'
import { Check, Copy, ExternalLink } from 'lucide-react'

/** A device-code sign-in: the one-time code, and the page to enter it on in case no browser opened. */
export function DeviceCodeSignIn({
  hint,
  userCode,
  verificationUrl,
  copied,
  onCopy,
  onOpen,
  buttonClassName,
}: {
  hint: string
  userCode: string
  /** Already checked to be the provider's verification page; without one, only the code shows. */
  verificationUrl: string | null
  /** The text last copied from the card, which its button marks as copied. */
  copied: string | null
  onCopy: (text: string) => void
  onOpen: (url: string) => void
  buttonClassName: string
}) {
  const { t } = useTranslation('chat')
  const copiedLabel = t('settings.subscriptionLoginLinkCopied')
  return (
    <div
      className="mt-3 rounded-md border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5"
      data-subscription-device-code
    >
      <p className="text-[12px] text-amber-100">{hint}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="select-all font-mono text-[15px] font-semibold tracking-[0.18em] text-foreground">
          {userCode}
        </code>
        <button type="button" className={buttonClassName} onClick={() => onCopy(userCode)}>
          {copied === userCode ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied === userCode ? copiedLabel : t('settings.subscriptionDeviceCodeCopy')}
        </button>
      </div>
      {verificationUrl && (
        <div className="mt-2.5" data-subscription-device-link>
          <p className="text-[12px] text-amber-100">{t('settings.subscriptionDeviceLinkHint')}</p>
          <code className="mt-1 block select-all break-all font-mono text-[11px] text-foreground/90">
            {verificationUrl}
          </code>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className={buttonClassName} onClick={() => onCopy(verificationUrl)}>
              {copied === verificationUrl ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied === verificationUrl ? copiedLabel : t('settings.subscriptionLoginLinkCopy')}
            </button>
            <button type="button" className={buttonClassName} onClick={() => onOpen(verificationUrl)}>
              <ExternalLink className="h-3.5 w-3.5" />
              {t('settings.subscriptionLoginLinkOpen')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
