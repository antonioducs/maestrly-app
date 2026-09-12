import { useEffect, useState } from 'react'
import { Download, Trash2 } from 'lucide-react'
import type { LocalDataSummary } from '../../../shared/local-data'
import type { TFn } from './shared'

export function LocalDataSection({ t }: { t: TFn }) {
  const [summary, setSummary] = useState<LocalDataSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let disposed = false
    void window.api.getLocalDataSummary().then(
      (value) => {
        if (!disposed) setSummary(value)
      },
      () => {
        if (!disposed) setFailed(true)
      }
    )
    return () => {
      disposed = true
    }
  }, [])

  async function perform(action: 'export' | 'reset') {
    setBusy(true)
    setMessage('')
    setFailed(false)
    try {
      if (action === 'export') {
        const result = await window.api.exportData()
        if (result.ok) {
          setFailed(result.incomplete)
          setMessage(
            [
              t('localData.exported', { path: result.path }),
              ...(result.incomplete ? [t('localData.exportIncomplete'), ...result.omissions] : []),
            ].join('\n')
          )
        } else if (!result.canceled) {
          setFailed(true)
          setMessage(result.error ?? t('localData.error'))
        }
      } else {
        const result = await window.api.resetLocalData()
        if (result.ok) window.location.reload()
        else {
          setFailed(true)
          setMessage(result.error)
        }
      }
    } catch (error) {
      setFailed(true)
      setMessage(error instanceof Error ? error.message : t('localData.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5">
      <div>
        <div className="text-sm font-medium text-foreground">{t('localData.title')}</div>
        <p className="text-[11px] leading-snug text-muted-foreground">{t('localData.description')}</p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{t('localData.repositoryFiles')}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        {summary ? t('localData.summary', { ...summary }) : t(failed ? 'localData.error' : 'localData.loading')}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void perform('export')}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground disabled:opacity-50"
        >
          <Download className="size-3.5" /> {t(busy ? 'localData.busy' : 'localData.export')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void perform('reset')}
          className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 px-2.5 py-1.5 text-xs text-red-400 disabled:opacity-50"
        >
          <Trash2 className="size-3.5" /> {t('localData.reset')}
        </button>
      </div>
      {message && (
        <p role={failed ? 'alert' : 'status'} className="whitespace-pre-wrap break-all text-xs text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  )
}
