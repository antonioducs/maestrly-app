import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePanelMemoryEviction } from '@/lib/panel-memory-eviction'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import {
  GitCompare,
  GitPullRequest,
  GitBranch,
  CheckCircle2,
  XCircle,
  Clock,
  MinusCircle,
  MessageSquare,
  RotateCw,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react'
import type { MultiReviewData, ReviewData, ReviewError } from '../../preload'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConflictResolver } from '@/components/ConflictResolver'

interface Props {
  convId: string | null

  visible: boolean

  onOpenFile: (path: string, line?: number) => void

  onOpenUrl: (url: string) => void
}

type Sub = 'diff' | 'pr' | 'checks' | 'comments'

const ERROR_HINT_KEY: Record<ReviewError, string> = {
  'no-gh': 'review.errorHint.noGh',
  'not-logged-in': 'review.errorHint.notLoggedIn',
  'no-repo': 'review.errorHint.noRepo',
  'no-remote': 'review.errorHint.noRemote',
  'no-pr': 'review.errorHint.noPr',
}

export function ReviewPanel({ convId, visible, onOpenFile, onOpenUrl }: Props) {
  const { t } = useTranslation('ui')
  const [data, setData] = useState<MultiReviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [sub, setSub] = useState<Sub>('diff')
  const [repoIdx, setRepoIdx] = useState(0)

  const reqId = useRef(0)
  usePanelMemoryEviction(
    convId ?? '',
    'review',
    useCallback(() => ({ safe: true }), [])
  )

  async function load() {
    if (!convId) return
    const my = ++reqId.current
    setLoading(true)
    try {
      const d = await window.api.getReview(convId)
      if (my === reqId.current) {
        setData(d)
        setRepoIdx(0)
      }
    } catch {
      if (my === reqId.current) setData(null)
    } finally {
      if (my === reqId.current) setLoading(false)
    }
  }

  useEffect(() => {
    setData(null)
    setRepoIdx(0)
    if (visible && convId) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, visible])

  const repos = data?.repos ?? []
  const cur = repos[repoIdx] ?? repos[0] ?? null
  const failed = (cur?.checks ?? []).some((c) => c.bucket === 'fail')
  const pr = cur?.pr ?? null

  const openInRepo = (path: string, line?: number) => onOpenFile(cur?.linkName ? `${cur.linkName}/${path}` : path, line)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {repos.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {repos.map((r, i) => (
            <button
              key={i}
              onClick={() => setRepoIdx(i)}
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs',
                i === repoIdx ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50'
              )}
            >
              <GitBranch className="size-3 opacity-60" />
              {r.linkName}
              {(r.checks ?? []).some((c) => c.bucket === 'fail') && (
                <span className="size-1.5 rounded-full bg-destructive" />
              )}
            </button>
          ))}
        </div>
      )}

      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-white/[0.04] p-0.5 ring-1 ring-white/[0.05]">
          <SubBtn
            icon={<GitCompare className="size-3.5" />}
            label={t('review.tabDiff')}
            active={sub === 'diff'}
            onClick={() => setSub('diff')}
          />
          <SubBtn
            icon={<GitPullRequest className="size-3.5" />}
            label={t('review.tabPr')}
            active={sub === 'pr'}
            onClick={() => setSub('pr')}
          />
          <SubBtn
            icon={<CheckCircle2 className="size-3.5" />}
            label={t('review.tabChecks')}
            active={sub === 'checks'}
            onClick={() => setSub('checks')}
            dot={failed}
          />
          <SubBtn
            icon={<MessageSquare className="size-3.5" />}
            label={t('review.tabComments')}
            active={sub === 'comments'}
            onClick={() => setSub('comments')}
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => void load()}
          disabled={loading}
          title={t('common.refresh')}
        >
          <RotateCw className={cn('size-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {!convId ? (
          <Hint>{t('review.selectConv')}</Hint>
        ) : loading && !cur ? (
          <Hint>{t('review.loading')}</Hint>
        ) : !cur ? (
          <Hint>{t('review.noData')}</Hint>
        ) : (
          <>
            {cur.error && cur.error !== 'no-pr' && <Banner>{t(ERROR_HINT_KEY[cur.error])}</Banner>}
            {sub === 'diff' && <DiffTab data={cur} onOpenFile={openInRepo} />}
            {sub === 'pr' && (
              <PrTab
                pr={pr}
                branch={cur.branch}
                noPrHint={cur.error === 'no-pr'}
                onOpenUrl={onOpenUrl}
                convId={convId}
                multiRepo={repos.length > 1}
                onResolved={() => void load()}
              />
            )}
            {sub === 'checks' && <ChecksTab data={cur} onOpenUrl={onOpenUrl} />}
            {sub === 'comments' && <CommentsTab data={cur} onOpenFile={openInRepo} />}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------- Diff ----------------
function DiffTab({ data, onOpenFile }: { data: ReviewData; onOpenFile: (p: string, line?: number) => void }) {
  const { t } = useTranslation('ui')
  if (!data.diff.trim())
    return <Hint>{data.diffSource === 'pr' ? t('review.noChangesPr') : t('review.noChangesBranch')}</Hint>
  return (
    <div className="p-3">
      <div className="mb-2 text-[11px] text-muted-foreground">
        {data.diffSource === 'pr' ? t('review.diffPr') : t('review.diffLocal')}
      </div>
      <UnifiedDiffView diff={data.diff} onOpenFile={onOpenFile} />
    </div>
  )
}

interface DiffFile {
  path: string
  lines: { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string }[]
}

function UnifiedDiffView({ diff, onOpenFile }: { diff: string; onOpenFile: (p: string, line?: number) => void }) {
  const { t } = useTranslation('ui')
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  return (
    <div className="flex flex-col gap-3">
      {files.map((f, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-border">
          <button
            onClick={() => onOpenFile(f.path)}
            className="flex w-full items-center gap-1.5 border-b border-border bg-white/[0.03] px-2 py-1.5 text-left font-mono text-[11.5px] text-foreground/90 hover:bg-white/[0.06]"
            title={t('review.openInVsCode')}
          >
            <GitCompare className="size-3.5 shrink-0 opacity-50" />
            <span className="truncate">{f.path}</span>
          </button>
          <div className="font-mono text-[12px] leading-relaxed">
            {f.lines.map((r, j) => (
              <div
                key={j}
                className={cn(
                  'flex gap-2 whitespace-pre-wrap break-words px-2 py-px',
                  r.kind === 'add' && 'bg-status-ready/10 text-status-ready',
                  r.kind === 'del' && 'bg-destructive/10 text-destructive',
                  r.kind === 'ctx' && 'text-foreground/45',
                  r.kind === 'hunk' && 'bg-primary/5 text-primary/70',
                  r.kind === 'meta' && 'text-foreground/30'
                )}
              >
                <span className="select-none opacity-60">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
                <span className="min-w-0 flex-1">{r.text || ' '}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

const unq = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s)

function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = { path: '', lines: [] }
      files.push(cur)
      const m = raw.match(/ b\/(.+)$/)
      if (m) cur.path = unq(m[1])
      continue
    }
    if (!cur) continue
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim()
      if (p !== '/dev/null') cur.path = unq(p).replace(/^b\//, '')
      cur.lines.push({ kind: 'meta', text: raw })
    } else if (raw.startsWith('--- ')) {
      const p = raw.slice(4).trim()
      if (!cur.path && p !== '/dev/null') cur.path = unq(p).replace(/^a\//, '') // Deleted files use the a/ path.
      cur.lines.push({ kind: 'meta', text: raw })
    } else if (raw.startsWith('@@')) cur.lines.push({ kind: 'hunk', text: raw })
    else if (
      raw.startsWith('index ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('similarity ') ||
      raw.startsWith('rename ') ||
      raw.startsWith('copy ') ||
      raw.startsWith('Binary ') ||
      raw.startsWith('\\ ')
    )
      cur.lines.push({ kind: 'meta', text: raw })
    else if (raw.startsWith('+')) cur.lines.push({ kind: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) cur.lines.push({ kind: 'del', text: raw.slice(1) })
    else cur.lines.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }
  return files
}

// ---------------- PR ----------------
function PrTab({
  pr,
  branch,
  noPrHint,
  onOpenUrl,
  convId,
  multiRepo,
  onResolved,
}: {
  pr: ReviewData['pr']
  branch: string
  noPrHint: boolean
  onOpenUrl: (url: string) => void
  convId: string | null
  multiRepo: boolean
  onResolved: () => void
}) {
  const { t } = useTranslation('ui')
  if (!pr) return <Hint>{noPrHint ? t('review.noPrForBranch', { branch }) : t('review.noPr')}</Hint>
  return (
    <div className="p-3">
      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{pr.title}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              #{pr.number} · {branch} → {pr.baseRef}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => onOpenUrl(pr.url)}
            title={t('review.openInGitHub')}
          >
            <ExternalLink className="size-4" />
          </Button>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Badge tone={pr.state === 'OPEN' ? 'ok' : pr.state === 'MERGED' ? 'info' : 'muted'}>
            {pr.isDraft ? 'DRAFT' : pr.state}
          </Badge>
          {pr.reviewDecision && (
            <Badge
              tone={
                pr.reviewDecision === 'APPROVED' ? 'ok' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'bad' : 'warn'
              }
            >
              {pr.reviewDecision.replace(/_/g, ' ').toLowerCase()}
            </Badge>
          )}
          {pr.mergeable === 'CONFLICTING' && <Badge tone="bad">{t('review.conflicts')}</Badge>}
          {['BLOCKED', 'BEHIND', 'DIRTY', 'UNSTABLE'].includes(pr.mergeStateStatus) && (
            <Badge tone="warn">{pr.mergeStateStatus.toLowerCase()}</Badge>
          )}
          <Badge tone="muted">
            <span className="text-status-ready">+{pr.additions}</span>{' '}
            <span className="text-destructive">−{pr.deletions}</span> ·{' '}
            {t('review.filesShort', { count: pr.changedFiles })}
          </Badge>
        </div>
      </div>

      {pr.mergeable === 'CONFLICTING' &&
        (multiRepo ? (
          <PrNote>{t('review.multiRepoNote')}</PrNote>
        ) : convId ? (
          <ConflictResolver convId={convId} onResolved={onResolved} />
        ) : null)}
      {/* GitHub has not calculated mergeability yet; offer a refresh. */}
      {pr.mergeable === 'UNKNOWN' && <PrNote>{t('review.unknownMergeNote')}</PrNote>}
    </div>
  )
}

function PrNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-border bg-white/[0.03] p-2.5 text-[11px] leading-snug text-muted-foreground">
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-status-working" />
      <span>{children}</span>
    </div>
  )
}

// ---------------- Checks ----------------
function ChecksTab({ data, onOpenUrl }: { data: ReviewData; onOpenUrl: (url: string) => void }) {
  const { t } = useTranslation('ui')
  if (!data.pr) return <Hint>{t('review.noPrNoChecks')}</Hint>
  if (data.checks.length === 0) return <Hint>{t('review.noChecks')}</Hint>
  return (
    <div className="flex flex-col gap-1 p-3">
      {data.checks.map((c, i) => (
        <button
          key={i}
          onClick={() => c.link && onOpenUrl(c.link)}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/[0.04]"
          title={c.link ? t('review.openDetails') : undefined}
        >
          <CheckIcon bucket={c.bucket} />
          <span className="min-w-0 flex-1 truncate text-foreground/90">{c.name}</span>
          {c.workflow && <span className="shrink-0 text-[10px] text-muted-foreground">{c.workflow}</span>}
        </button>
      ))}
    </div>
  )
}

function CheckIcon({ bucket }: { bucket: string }) {
  if (bucket === 'pass') return <CheckCircle2 className="size-4 shrink-0 text-status-ready" />
  if (bucket === 'fail') return <XCircle className="size-4 shrink-0 text-destructive" />
  if (bucket === 'pending') return <Clock className="size-4 shrink-0 text-status-working" />
  return <MinusCircle className="size-4 shrink-0 text-muted-foreground" />
}

function CommentsTab({ data, onOpenFile }: { data: ReviewData; onOpenFile: (p: string, line?: number) => void }) {
  const { t } = useTranslation('ui')
  if (data.comments.length === 0) return <Hint>{t('review.noComments')}</Hint>
  return (
    <div className="flex flex-col gap-2.5 p-3">
      {data.comments.map((c, i) => (
        <div key={i} className="rounded-lg border border-border p-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[11px]">
            <span className="font-medium text-foreground/90">{c.author}</span>
            {c.kind === 'review' && c.state && (
              <Badge tone={c.state === 'APPROVED' ? 'ok' : c.state === 'CHANGES_REQUESTED' ? 'bad' : 'muted'}>
                {c.state.replace(/_/g, ' ').toLowerCase()}
              </Badge>
            )}
            {c.kind === 'inline' && c.path && (
              <button
                onClick={() => onOpenFile(c.path!, c.line)}
                className="truncate font-mono text-[10px] text-primary hover:underline"
                title={t('review.openFile')}
              >
                {c.path}
                {c.line ? `:${c.line}` : ''}
              </button>
            )}
          </div>
          {c.body.trim() ? (
            <div className="space-y-1 text-xs leading-relaxed text-foreground/80 [&_a]:text-primary [&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:py-px [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-black/30 [&_pre]:p-2">
              <ReactMarkdown>{c.body}</ReactMarkdown>
            </div>
          ) : (
            <div className="text-[11px] italic text-muted-foreground">{t('review.noText')}</div>
          )}
        </div>
      ))}
    </div>
  )
}

function SubBtn({
  icon,
  label,
  active,
  onClick,
  dot,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  dot?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-all duration-150',
        active
          ? 'bg-white/[0.08] text-foreground shadow-sm ring-1 ring-white/[0.06]'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      {label}
      {dot && <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-destructive" />}
    </button>
  )
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'bad' | 'warn' | 'info' | 'muted' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        tone === 'ok' && 'bg-status-ready/15 text-status-ready',
        tone === 'bad' && 'bg-destructive/15 text-destructive',
        tone === 'warn' && 'bg-status-working/15 text-status-working',
        tone === 'info' && 'bg-primary/15 text-primary',
        tone === 'muted' && 'bg-white/[0.06] text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-border bg-white/[0.03] px-3 py-2 text-[11px] text-muted-foreground">{children}</div>
  )
}
