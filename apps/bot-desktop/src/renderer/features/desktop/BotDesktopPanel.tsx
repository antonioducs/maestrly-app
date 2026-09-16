import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import type { Bot } from '@maestrly/host-protocol'
import { Button } from '../../ui'
import { useT } from '../../i18n'
import type { TranslationKey } from '../../i18n/pt-BR'
import { DesktopCanvas } from './DesktopCanvas'
import { useDesktopSession } from './useDesktopSession'

const ERRORS: Record<string, TranslationKey> = {
  DESKTOP_UPDATE_REQUIRED: 'desktopUpdate',
  DESKTOP_UNAVAILABLE: 'desktopUnavailable',
  CONTROL_BUSY: 'desktopControlledElsewhere',
  HANDOFF_UNCERTAIN: 'desktopBlocked',
  VIEWER_LIMIT: 'desktopViewerLimit',
  STALE_DESKTOP: 'desktopStale',
  BUDGET_EXHAUSTED: 'desktopBudget',
  ACCOUNT_REQUIRED: 'desktopAccountRequired',
  CONTROL_EXPIRED: 'desktopControlExpired',
}
/**
 * The bot's live screen next to the conversation. Opening it only watches; taking
 * control is an explicit action, and only one primary action is offered per state.
 */
export function BotDesktopPanel({
  bot,
  expanded,
  onExpand,
  onClose,
}: {
  bot: Bot
  expanded: boolean
  onExpand: () => void
  onClose: () => void
}) {
  const t = useT()
  const session = useDesktopSession(bot.id, true)
  const [confirmClose, setConfirmClose] = useState(false)
  const [notice, setNotice] = useState<TranslationKey>()
  const [live, setLive] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const primaryButton = useRef<HTMLButtonElement>(null)
  useEffect(() => heading.current?.focus(), [])
  const state = session.state
  const mode = state?.mode ?? 'bot'
  const busy = session.phase === 'acquiring' || session.phase === 'returning' || mode === 'acquiring' || mode === 'resuming'
  const status: TranslationKey =
    session.phase === 'error' ? (ERRORS[session.error ?? ''] ?? 'desktopUnavailable')
      : session.phase === 'reconnecting' ? 'desktopReconnecting'
        : session.phase === 'acquiring' || mode === 'acquiring' ? 'desktopAcquiring'
          : session.phase === 'returning' || mode === 'resuming' ? 'desktopReturning'
            : session.controlling ? 'desktopControlling'
              : mode === 'human' ? 'desktopControlledElsewhere'
                : mode === 'paused' ? 'desktopPaused'
                  : mode === 'blocked' ? 'desktopBlocked'
                    : !live ? 'desktopConnecting'
                      : 'desktopObserving'
  const canHandoff = !!state?.capabilities.includes('desktop.handoff.v1')
  const handBack = async (continueTask: boolean) => {
    setNotice(undefined)
    const result = await session.returnControl(continueTask)
    if (result?.continued) setNotice('continuedNotice')
    primaryButton.current?.focus()
  }
  const primary: { label: TranslationKey; run: () => void } | undefined =
    session.phase === 'error' ? undefined
      : session.controlling ? { label: state?.interruptedTurnId ? 'returnAndContinue' : 'returnControl', run: () => void handBack(true) }
        : mode === 'paused' || mode === 'blocked' ? { label: 'continueBot', run: () => void handBack(true) }
          : mode === 'bot' && canHandoff ? { label: 'takeControl', run: () => void session.acquire() }
            : undefined
  const secondary: { label: TranslationKey; run: () => void } | undefined =
    !session.controlling && (mode === 'paused' || mode === 'blocked') && canHandoff ? { label: 'takeControl', run: () => void session.acquire() } : undefined
  const close = () => (session.controlling ? setConfirmClose(true) : onClose())
  const errorKey = session.error && session.phase !== 'error' ? (ERRORS[session.error] ?? 'desktopError') : undefined
  return (
    <aside className={`desktop-panel${expanded ? ' expanded' : ''}`} role="region" aria-labelledby="desktop-title">
      <header className="desktop-toolbar">
        <div className="desktop-heading">
          <h2 id="desktop-title" ref={heading} tabIndex={-1}>{t('desktopTitle')}</h2>
          <p role="status" aria-live="polite" data-mode={session.controlling ? 'controlling' : mode}>
            <span className="status-dot" />
            {t(status)}
          </p>
        </div>
        <div className="desktop-actions">
          {primary && (
            <Button ref={primaryButton} className="primary" disabled={busy || session.phase === 'connecting' || session.phase === 'reconnecting'} onClick={primary.run}>
              {t(primary.label)}
            </Button>
          )}
          {busy && !primary && <Button disabled>{t(status)}</Button>}
          {secondary && <Button disabled={busy} onClick={secondary.run}>{t(secondary.label)}</Button>}
          <Button aria-pressed={expanded} aria-label={t(expanded ? 'collapse' : 'expand')} title={t(expanded ? 'collapse' : 'expand')} onClick={onExpand}>
            {expanded ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
          </Button>
          <Button aria-label={t('closeDesktop')} title={t('closeDesktop')} onClick={close}>
            <X size={15} aria-hidden="true" />
          </Button>
        </div>
      </header>
      <p className="desktop-explain">
        {session.controlling ? t('keyboardHint') : mode === 'bot' && canHandoff && session.phase !== 'error' ? t('takeoverExplain') : mode === 'paused' ? t('pausedBanner') : ''}
      </p>
      {notice && <p className="desktop-notice" role="status">{t(notice)}</p>}
      {errorKey && <p className="desktop-error" role="alert">{t(errorKey)}</p>}
      {session.phase === 'error' ? (
        <div className="desktop-message">
          <h3>{t(status)}</h3>
          <p>{t(session.error === 'DESKTOP_UPDATE_REQUIRED' ? 'desktopUpdateText' : 'desktopUnavailableText')}</p>
          {session.error !== 'DESKTOP_UPDATE_REQUIRED' && <Button onClick={session.retry}>{t('retryDesktop')}</Button>}
        </div>
      ) : (
        <DesktopCanvas
          socket={session.socket}
          controlling={session.controlling}
          framebuffer={{ width: state?.width || 1280, height: state?.height || 800 }}
          stale={session.phase === 'reconnecting'}
          onInput={session.input}
          onConnected={() => setLive(true)}
          onDisconnected={() => setLive(false)}
          onReleaseKeyboard={() => primaryButton.current?.focus()}
        />
      )}
      <details className="desktop-more">
        <summary>{t('moreOptions')}</summary>
        <dl>
          <div><dt>{t('desktopResolution')}</dt><dd>{state?.width || '—'} × {state?.height || '—'}</dd></div>
          <div><dt>{t('desktopWatchers')}</dt><dd>{state?.viewers ?? 0}</dd></div>
        </dl>
        {(mode === 'paused' || mode === 'blocked' || session.controlling) && (
          <Button disabled={busy} onClick={() => void handBack(false)}>{t('returnWithoutContinuing')}</Button>
        )}
        {session.phase !== 'error' && <Button onClick={session.retry}>{t('retryDesktop')}</Button>}
      </details>
      {confirmClose && (
        <dialog
          ref={(node) => {
            if (node && !node.open) node.showModal()
          }}
          aria-labelledby="desktop-close-title"
          onCancel={() => setConfirmClose(false)}
        >
          <h2 id="desktop-close-title">{t('closeWhileControlling')}</h2>
          <p>{t('closeWhileControllingText')}</p>
          <Button onClick={() => setConfirmClose(false)}>{t('cancel')}</Button>
          <Button onClick={() => { setConfirmClose(false); onClose() }}>{t('keepPaused')}</Button>
          <Button className="primary" onClick={() => void handBack(true).then(() => { setConfirmClose(false); onClose() })}>
            {t(state?.interruptedTurnId ? 'returnAndContinue' : 'returnControl')}
          </Button>
        </dialog>
      )}
    </aside>
  )
}
