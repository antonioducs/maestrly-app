import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useGenUiHost } from './context'
import { genUiLibrary } from './library'
import { loadGenUiState, programHash, saveGenUiState } from './persist'
import { type GenUiEffect, type GenUiState, useGenUiProgram } from './runtime'

// Loaded on demand with the language runtime: a chat downloads it once a message holds an interface.
export default function OpenUIBlock({ code }: { code: string }) {
  const { live, stateKey } = useGenUiHost()
  // While the message streams the program keeps changing; what the person changes happens after, on the final one
  const key = !live && stateKey ? `${stateKey}:${programHash(code)}` : null
  const initialState = useMemo(() => (key ? loadGenUiState(key) : undefined), [key])
  // A restored state belongs to the final program: remount when the stream ends and a saved state applies
  return <Program key={initialState ? key : 'program'} code={code} stateKey={key} initialState={initialState} />
}

function Program({
  code,
  stateKey,
  initialState,
}: {
  code: string
  stateKey: string | null
  initialState?: GenUiState
}) {
  const { t } = useTranslation('ui')
  const { live, send } = useGenUiHost()
  const onEffect = useCallback(
    (effect: GenUiEffect) => {
      if (effect.kind === 'send') send?.(effect.text)
      else if (/^https?:\/\//i.test(effect.url)) void window.api.openExternalUrl(effect.url)
    },
    [send]
  )
  const onStateChange = useCallback(
    (state: GenUiState) => {
      if (stateKey) saveGenUiState(stateKey, state)
    },
    [stateKey]
  )
  const { content, failure } = useGenUiProgram({
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
      <details className="text-[11px] text-muted-foreground" open={failure !== null}>
        <summary className="cursor-pointer select-none hover:text-foreground">{t('genUi.source')}</summary>
        <pre className="mt-1.5 max-h-64 overflow-auto">
          <code>{code}</code>
        </pre>
      </details>
    </div>
  )
}
