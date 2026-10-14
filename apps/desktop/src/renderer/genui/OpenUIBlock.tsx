import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { safeWebUrl } from '../../shared/genui-widget'
import { useGenUiHost } from './context'
import { GenUiIssues } from './GenUiIssues'
import { GenUiSource } from './GenUiSource'
import { genUiLibrary } from './library'
import { loadGenUiState, programHash, saveGenUiState } from './persist'
import { type GenUiEffect, type GenUiState, useGenUiProgram } from './runtime'

// Loaded on demand with the language runtime: a chat downloads it once a message holds an interface.
export default function OpenUIBlock({ code, complete }: { code: string; complete: boolean }) {
  const host = useGenUiHost()
  // Until its closing fence arrives the program keeps changing; what the person changes happens on the final one
  const live = host.live && !complete
  const key = !live && host.stateKey ? `${host.stateKey}:${programHash(code)}` : null
  const initialState = useMemo(() => (key ? loadGenUiState(key) : undefined), [key])
  // A restored state belongs to the final program: remount when the stream ends and a saved state applies
  return (
    <Program key={initialState ? key : 'program'} code={code} live={live} stateKey={key} initialState={initialState} />
  )
}

function Program({
  code,
  live,
  stateKey,
  initialState,
}: {
  code: string
  live: boolean
  stateKey: string | null
  initialState?: GenUiState
}) {
  const { t } = useTranslation('ui')
  const { send } = useGenUiHost()
  const onEffect = useCallback(
    (effect: GenUiEffect) => {
      if (effect.kind === 'send') send?.(effect.text)
      else {
        const url = safeWebUrl(effect.url)
        if (url) void window.api.openExternalUrl(url)
      }
    },
    [send]
  )
  const onStateChange = useCallback(
    (state: GenUiState) => {
      if (stateKey) saveGenUiState(stateKey, state)
    },
    [stateKey]
  )
  const { content, failure, issues } = useGenUiProgram({
    code,
    library: genUiLibrary,
    live,
    initialState,
    onStateChange,
    onEffect,
    canSend: !!send,
  })

  return (
    <div className="genui-block my-2 flex min-w-0 flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.015] p-3 not-italic">
      {content}
      {failure !== null && (
        <p className="m-0 text-[12px] text-muted-foreground" title={failure}>
          {t('genUi.invalid')}
        </p>
      )}
      <GenUiIssues issues={issues} />
      <GenUiSource code={code} open={failure !== null} />
    </div>
  )
}
