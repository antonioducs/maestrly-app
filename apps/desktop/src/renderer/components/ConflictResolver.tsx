import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, GitMerge, Loader2, MessagesSquare } from 'lucide-react'
import type { ResolveConflictsResult, ResolveConflictsStatus } from '../../preload'
import { cn } from '@/lib/utils'

const STATUS_KEY: Record<ResolveConflictsStatus, string> = {
  resolved: 'conflictResolver.status.resolved',
  'no-pr': 'conflictResolver.status.noPr',
  'not-conflicting': 'conflictResolver.status.notConflicting',
  unknown: 'conflictResolver.status.unknown',
  'multi-repo-unsupported': 'conflictResolver.status.multiRepoUnsupported',
  dirty: 'conflictResolver.status.dirty',
  'cwd-locked': 'conflictResolver.status.cwdLocked',
  'agent-unavailable': 'conflictResolver.status.agentUnavailable',
  unresolved: 'conflictResolver.status.unresolved',
  'merge-incomplete': 'conflictResolver.status.mergeIncomplete',
  'not-pushed': 'conflictResolver.status.notPushed',
  'agent-failed': 'conflictResolver.status.agentFailed',
}

type Phase = 'idle' | 'running' | 'done' | 'error'

export function ConflictResolver({ convId, onResolved }: { convId: string; onResolved: () => void }) {
  const { t } = useTranslation('ui')
  const [phase, setPhase] = useState<Phase>('idle')
  const [msg, setMsg] = useState('')

  async function run() {
    setPhase('running')
    setMsg(t('conflictResolver.resolving'))
    try {
      const result: ResolveConflictsResult = await window.api.resolveConflicts(convId, {})
      setMsg(t(STATUS_KEY[result.status]) ?? result.reason ?? t('conflictResolver.failed'))
      setPhase(result.ok ? 'done' : 'error')
      if (result.ok) onResolved()
    } catch {
      setPhase('error')
      setMsg(t('conflictResolver.triggerFailed'))
    }
  }

  const running = phase === 'running'
  return (
    <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/[0.04] p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <GitMerge className="size-3.5 text-destructive" />
        {t('conflictResolver.title')}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{t('conflictResolver.desc')}</p>
      <div className="mt-2.5 flex items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-xs text-foreground">
        <MessagesSquare className="size-4 text-primary" />
        {t('conflictResolver.chatSelector')}
      </div>
      <button
        type="button"
        onClick={() => void run()}
        disabled={running}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {running ? <Loader2 className="size-3.5 animate-spin" /> : <GitMerge className="size-3.5" />}
        {running ? t('conflictResolver.resolvingShort') : t('conflictResolver.action')}
      </button>
      {phase !== 'idle' && msg && (
        <div
          className={cn(
            'mt-2 flex items-start gap-1.5 text-[11px]',
            phase === 'done' ? 'text-status-ready' : phase === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {phase === 'done' ? (
            <CheckCircle2 className="size-3.5" />
          ) : phase === 'error' ? (
            <AlertTriangle className="size-3.5" />
          ) : (
            <Loader2 className="size-3.5 animate-spin" />
          )}
          <span>{msg}</span>
        </div>
      )}
    </div>
  )
}
