import { useCallback, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { GitBranch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ConversationBranchInfo, ConversationBranchRepoInfo } from '../../preload'
import { cn } from '@/lib/utils'

export function ConversationBranchChip({
  conversationId,
  status,
  className,
}: {
  conversationId: string
  status?: string
  className?: string
}) {
  const { t } = useTranslation('ui')
  const [info, setInfo] = useState<ConversationBranchInfo | null>(null)
  const requestRef = useRef(0)
  const previousStatusRef = useRef<{ conversationId: string; status?: string }>({ conversationId })

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    const next = await window.api.getConversationBranchInfo(conversationId).catch(() => null)
    if (request === requestRef.current) setInfo(next)
  }, [conversationId])

  useEffect(() => {
    setInfo(null)
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      requestRef.current++
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  useEffect(() => {
    const previous = previousStatusRef.current
    if (previous.conversationId === conversationId && previous.status === 'working' && status !== 'working') {
      void refresh()
    }
    previousStatusRef.current = { conversationId, status }
  }, [conversationId, status, refresh])

  if (!info || info.repos.length === 0) return null

  const label = info.isMulti ? t('app.branchRepos', { count: info.repos.length }) : headLabel(info.repos[0], t)
  const tooltip = info.repos.map((repo) => repoTooltip(repo, info.isMulti, t)).join('\n')
  const hasDivergence = info.repos.some((repo) => repo.diverged)

  return (
    <span
      className={cn(
        'flex min-w-0 max-w-52 shrink-0 items-center gap-1 rounded-md bg-white/[0.045] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground ring-1 ring-white/[0.07]',
        hasDivergence && 'text-amber-300/80 ring-amber-300/20',
        className
      )}
      title={tooltip}
    >
      <GitBranch className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}

function headLabel(repo: ConversationBranchRepoInfo, t: TFunction<'ui'>): string {
  if (repo.head.kind === 'branch') return repo.head.name
  if (repo.head.kind === 'detached') return t('app.branchDetached', { commit: repo.head.commit })
  return t('app.branchUnavailable')
}

function repoTooltip(repo: ConversationBranchRepoInfo, isMulti: boolean, t: TFunction<'ui'>): string {
  const actual = headLabel(repo, t)
  const prefix = isMulti ? `${repo.name}: ` : ''
  const current = `${prefix}${actual}`
  return repo.diverged ? `${current}\n${t('app.branchDiverged', { assigned: repo.assignedBranch })}` : current
}
