import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Trans } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Code2,
  Cpu,
  FolderPlus,
  GitBranch,
  MessageSquarePlus,
  MousePointer2,
  PanelRight,
  X,
  Settings,
  Sparkles,
  SquareTerminal,
  StickyNote,
} from 'lucide-react'
import { useSettings } from '@/lib/use-settings'
import { BrandMark } from './BrandMark'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Workspace } from '../../preload'

interface OnboardingFlowProps {
  workspaces: { id: string; name: string }[]
  /** Open project setup and return the exact created or imported workspace. */
  onAddWorkspace: () => Promise<Workspace | null>

  onCreateConversation: (workspaceId: string) => void
  /** Close the tour and persist onboarding.completed when finished or skipped. */
  onClose: () => void
}

export function OnboardingFlow({ workspaces, onAddWorkspace, onCreateConversation, onClose }: OnboardingFlowProps) {
  const { t } = useTranslation('ui')
  const { openSettings } = useSettings()
  const [step, setStep] = useState(0)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
  const targetWorkspace = selectedWorkspace ?? workspaces[0]
  const hasWorkspace = !!targetWorkspace
  const firstWorkspaceName = targetWorkspace?.name ?? t('onboarding.sampleRepo')

  const steps: { icon: ReactNode; title: string; body: ReactNode; visual: ReactNode }[] = [
    {
      icon: <BrandMark variant="mark" tone="mono" className="h-10" aria-label="Maestrly" />,
      title: t('onboarding.welcomeTitle'),
      visual: <WelcomeVisual />,
      body: <p className="text-sm leading-relaxed text-muted-foreground">{t('onboarding.welcomeBody')}</p>,
    },
    {
      icon: <Cpu className="size-6" />,
      title: t('onboarding.providerTitle'),
      visual: <ProviderVisual />,
      body: (
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-relaxed text-muted-foreground">{t('onboarding.providerBody')}</p>
          <Button variant="secondary" className="self-start gap-1.5" onClick={openSettings}>
            <Settings className="size-4" /> {t('onboarding.connectProvider')}
          </Button>
        </div>
      ),
    },
    {
      icon: <FolderPlus className="size-6" />,
      title: t('onboarding.workspaceTitle'),
      visual: <WorkspaceVisual hasWorkspace={hasWorkspace} workspaceName={firstWorkspaceName} />,
      body: (
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-relaxed text-muted-foreground">{t('onboarding.workspaceBody')}</p>
          <Button
            className="self-start gap-1.5"
            onClick={() =>
              void onAddWorkspace().then((workspace) => {
                if (!workspace) return
                setSelectedWorkspaceId(workspace.id)
                setStep(3)
              })
            }
          >
            <FolderPlus className="size-4" /> {t('onboarding.addWorkspace')}
          </Button>
          {hasWorkspace && (
            <div className="flex items-center gap-2 rounded-lg border border-status-ready/30 bg-status-ready/10 px-3 py-2 text-sm text-status-ready">
              <CheckCircle2 className="size-4 shrink-0" />
              <span className="truncate">
                {workspaces.length === 1
                  ? t('onboarding.workspaceAddedOne', { name: workspaces[0]!.name })
                  : t('onboarding.workspaceAddedMany', { count: workspaces.length })}
              </span>
            </div>
          )}
        </div>
      ),
    },
    {
      icon: <MessageSquarePlus className="size-6" />,
      title: t('onboarding.convTitle'),
      visual: <ConversationVisual enabled={hasWorkspace} workspaceName={firstWorkspaceName} />,
      body: (
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-relaxed text-muted-foreground">{t('onboarding.convBody')}</p>
          <Button
            className="self-start gap-1.5"
            disabled={!hasWorkspace}
            onClick={() => targetWorkspace && onCreateConversation(targetWorkspace.id)}
          >
            <MessageSquarePlus className="size-4" /> {t('onboarding.createFirstConv')}
          </Button>
          {!hasWorkspace && (
            <p className="text-[12px] text-muted-foreground/80">{t('onboarding.convNeedsWorkspace')}</p>
          )}
        </div>
      ),
    },
    {
      icon: <PanelRight className="size-6" />,
      title: t('onboarding.exploreTitle'),
      visual: <ExploreVisual />,
      body: (
        <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            <Trans i18nKey="onboarding.exploreDrawer" t={t} components={{ b: <b className="text-foreground/90" /> }} />
          </p>
          <p>
            <Trans
              i18nKey="onboarding.exploreKnowledge"
              t={t}
              components={{ b: <b className="text-foreground/90" /> }}
            />
          </p>
          <p>{t('onboarding.exploreMore')}</p>
          <p className="text-[12px] text-muted-foreground/80">
            <Trans i18nKey="onboarding.exploreReopen" t={t} components={{ b: <b /> }} />
          </p>
        </div>
      ),
    },
  ]

  const total = steps.length
  const isFirst = step === 0
  const isLast = step === total - 1
  const cur = steps[step]!

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-10 shrink-0 items-center gap-2 hairline-b pl-3 pr-2">
        <Sparkles className="size-4 text-muted-foreground" />
        <span className="truncate text-[13px] font-medium text-foreground/90">{t('onboarding.headerTitle')}</span>
        <button
          type="button"
          onClick={onClose}
          className="no-drag ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          title={t('onboarding.skipTitle')}
        >
          {t('onboarding.skip')} <X className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(22rem,1.1fr)]">
          <section className="flex min-w-0 flex-col justify-center gap-5">
            <div className="flex size-12 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/25">
              {cur.icon}
            </div>
            <div className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground">{cur.title}</h2>
              {cur.body}
            </div>
          </section>
          <div className="min-w-0">{cur.visual}</div>
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 hairline-t px-4 py-3 sm:px-6">
        <div className="flex items-center gap-1.5">
          {steps.map((_, i) => (
            <span
              key={i}
              className={cn('h-1.5 rounded-full transition-all', i === step ? 'w-5 bg-primary' : 'w-1.5 bg-white/20')}
            />
          ))}
          <span className="ml-2 text-[11px] text-muted-foreground">
            {t('onboarding.progress', { current: step + 1, total })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" className="gap-1.5" disabled={isFirst} onClick={() => setStep((s) => s - 1)}>
            <ArrowLeft className="size-4" /> {t('onboarding.back')}
          </Button>
          {isLast ? (
            <Button className="gap-1.5" onClick={onClose}>
              {t('onboarding.finish')} <CheckCircle2 className="size-4" />
            </Button>
          ) : (
            <Button className="gap-1.5" onClick={() => setStep((s) => s + 1)}>
              {t('onboarding.next')} <ArrowRight className="size-4" />
            </Button>
          )}
        </div>
      </footer>
    </div>
  )
}

function VisualFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-border-strong bg-surface-elevated/70 shadow-2xl ring-1 ring-black/20">
      <div className="flex h-8 items-center gap-1.5 hairline-b px-3">
        <span className="size-2 rounded-full bg-status-error/80" />
        <span className="size-2 rounded-full bg-status-working/80" />
        <span className="size-2 rounded-full bg-status-ready/80" />
        <span className="ml-2 truncate text-[11px] text-muted-foreground">{label}</span>
      </div>
      <div className="relative min-h-[18rem] p-4 sm:min-h-[20rem]">{children}</div>
    </div>
  )
}

function AnimatedPointer({ className }: { className?: string }) {
  return (
    <div
      className={cn('onboarding-cursor pointer-events-none absolute z-10 text-foreground drop-shadow-lg', className)}
    >
      <MousePointer2 className="size-5 fill-foreground/80" />
    </div>
  )
}

function WelcomeVisual() {
  const { t } = useTranslation('ui')
  return (
    <VisualFrame label={t('onboarding.visualOverview')}>
      <div className="grid h-full min-h-[17rem] grid-cols-1 gap-3 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-2 rounded-md border border-white/10 bg-black/20 p-2">
          <div className="flex items-center gap-1.5 rounded bg-primary/15 px-2 py-1 text-[10px] font-medium text-foreground">
            <FolderPlus className="size-3" />
            {t('onboarding.mockWorkspace')}
          </div>
          {[t('onboarding.mockConv1'), t('onboarding.mockConv2'), t('onboarding.mockConv3')].map((name, i) => (
            <div key={name} className="rounded border border-white/8 bg-white/[0.04] px-2 py-1.5">
              <div className="flex items-center gap-1.5 text-[10px] text-foreground/90">
                <span className={cn('size-1.5 rounded-full', i === 0 ? 'bg-status-ready' : 'bg-primary')} />
                {name}
              </div>
              <div className="mt-1 h-1 rounded bg-white/10" />
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-3 rounded-md border border-white/10 bg-black/25 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
              <BrainCircuit className="size-3.5 text-primary" />
              {t('onboarding.mockAgentConv')}
            </div>
            <div className="flex items-center gap-1 rounded bg-status-ready/15 px-1.5 py-0.5 text-[9px] text-status-ready ring-1 ring-status-ready/25">
              <GitBranch className="size-2.5" />
              {t('onboarding.mockIsolatedBranch')}
            </div>
          </div>
          <div className="grid flex-1 grid-cols-[minmax(0,1fr)_5rem] gap-3">
            <div className="flex min-w-0 flex-col gap-2">
              <MessageBubble tone="user" width="w-4/5" />
              <MessageBubble tone="agent" width="w-full" />
              <MessageBubble tone="agent" width="w-2/3" />
            </div>
            <div className="grid grid-rows-3 gap-2">
              <MiniTool icon={<Code2 className="size-3" />} label={t('onboarding.toolCode')} />
              <MiniTool icon={<SquareTerminal className="size-3" />} label={t('onboarding.toolTerminal')} />
              <MiniTool icon={<BrainCircuit className="size-3" />} label={t('onboarding.toolMemory')} />
            </div>
          </div>
        </div>
      </div>
      <AnimatedPointer className="bottom-9 left-[42%]" />
    </VisualFrame>
  )
}

function ProviderVisual() {
  const { t } = useTranslation('ui')
  return (
    <VisualFrame label={t('onboarding.visualTools')}>
      <div className="flex min-h-[17rem] items-center justify-center">
        <div className="w-full rounded-md border border-primary/25 bg-primary/[0.08] px-4 py-5 text-primary">
          <div className="flex items-start gap-2">
            <Cpu className="mt-0.5 size-5" />
            <div>
              <div className="text-sm font-medium">{t('onboarding.providerTitle')}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t('onboarding.providerBody')}</div>
            </div>
          </div>
        </div>
      </div>
    </VisualFrame>
  )
}

function WorkspaceVisual({ hasWorkspace, workspaceName }: { hasWorkspace: boolean; workspaceName: string }) {
  const { t } = useTranslation('ui')
  return (
    <VisualFrame label={t('onboarding.visualGitWorkspace')}>
      <div className="flex h-full min-h-[17rem] flex-col justify-center gap-4">
        <div className="rounded-md border border-primary/25 bg-primary/[0.07] p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <FolderPlus className="size-4 text-primary" />
            {t('onboarding.selectRepo')}
          </div>
          <div className="mt-3 rounded border border-white/10 bg-black/25 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            {t('onboarding.mockPath', { name: workspaceName })}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {['main', 'feature/onboarding', 'review-fix'].map((branch, i) => (
            <div
              key={branch}
              className={cn(
                'rounded-md border px-2 py-2 text-[10px]',
                i === 1
                  ? 'border-status-ready/30 bg-status-ready/10 text-status-ready'
                  : 'border-white/10 bg-white/[0.035] text-muted-foreground'
              )}
            >
              <GitBranch className="mb-1 size-3" />
              <span className="block truncate">{branch}</span>
            </div>
          ))}
        </div>
        <div
          className={cn(
            'flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
            hasWorkspace
              ? 'border-status-ready/30 bg-status-ready/10 text-status-ready'
              : 'border-white/10 bg-white/[0.035] text-muted-foreground'
          )}
        >
          {hasWorkspace ? <CheckCircle2 className="size-4" /> : <FolderPlus className="size-4" />}
          <span className="truncate">
            {hasWorkspace ? t('onboarding.workspaceReady', { name: workspaceName }) : t('onboarding.noWorkspaceYet')}
          </span>
        </div>
      </div>
      {!hasWorkspace && <AnimatedPointer className="left-16 top-20" />}
    </VisualFrame>
  )
}

function ConversationVisual({ enabled, workspaceName }: { enabled: boolean; workspaceName: string }) {
  const { t } = useTranslation('ui')
  return (
    <VisualFrame label={t('onboarding.visualNewConv')}>
      <div className="flex h-full min-h-[17rem] items-center justify-center">
        <div className="w-full max-w-sm rounded-md border border-white/10 bg-black/25 p-3 shadow-xl">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-foreground">
            <MessageSquarePlus className="size-4 text-primary" />
            {t('onboarding.newConv')}
          </div>
          <MockField label={t('onboarding.fieldWorkspace')} value={workspaceName} />
          <MockField label={t('onboarding.fieldTool')} value="Maestrly Chat" accent />
          <MockField label={t('onboarding.fieldBranch')} value="feature/first-conversation" />
          <div
            className={cn(
              'mt-3 flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium',
              enabled
                ? 'bg-primary text-primary-foreground shadow-[0_0_24px_rgba(237,234,227,0.18)]'
                : 'bg-white/[0.06] text-muted-foreground ring-1 ring-white/10'
            )}
          >
            <MessageSquarePlus className="size-3.5" />
            {t('onboarding.createConv')}
          </div>
        </div>
      </div>
      {enabled && <AnimatedPointer className="bottom-12 right-16" />}
    </VisualFrame>
  )
}

function ExploreVisual() {
  const { t } = useTranslation('ui')
  return (
    <VisualFrame label={t('onboarding.visualExploreLater')}>
      <div className="grid h-full min-h-[17rem] grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_7.5rem]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="rounded-md border border-white/10 bg-black/25 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-foreground">
              <PanelRight className="size-4 text-primary" />
              {t('onboarding.convDrawer')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MiniTool icon={<Code2 className="size-3" />} label={t('onboarding.toolCode')} />
              <MiniTool icon={<SquareTerminal className="size-3" />} label={t('onboarding.toolTerminal')} />
              <MiniTool icon={<StickyNote className="size-3" />} label={t('onboarding.toolPlan')} />
              <MiniTool icon={<CheckCircle2 className="size-3" />} label={t('onboarding.toolReview')} />
            </div>
          </div>
          <div className="rounded-md border border-white/10 bg-black/20 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-foreground">
              <BrainCircuit className="size-4 text-status-ready" />
              {t('onboarding.projectKnowledge')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MiniTool icon={<StickyNote className="size-3" />} label={t('onboarding.featNotes')} />
              <MiniTool icon={<BrainCircuit className="size-3" />} label={t('onboarding.featMemory')} />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {[
            t('onboarding.featNotes'),
            t('onboarding.featMemory'),
            t('onboarding.featChatGpt'),
            t('onboarding.featTours'),
          ].map((name, i) => (
            <div
              key={name}
              className={cn(
                'rounded-md border px-2 py-2 text-center text-[10px]',
                i === 3
                  ? 'border-primary/30 bg-primary/[0.08] text-primary'
                  : 'border-white/10 bg-white/[0.035] text-muted-foreground'
              )}
            >
              {name}
            </div>
          ))}
        </div>
      </div>
    </VisualFrame>
  )
}

function MessageBubble({ tone, width }: { tone: 'user' | 'agent'; width: string }) {
  return (
    <div
      className={cn(
        'rounded-md border px-2 py-2',
        width,
        tone === 'user' ? 'ml-auto border-primary/30 bg-primary/[0.10]' : 'border-white/10 bg-white/[0.045]'
      )}
    >
      <div className="h-1.5 rounded bg-white/20" />
      <div className="mt-1.5 h-1.5 w-2/3 rounded bg-white/10" />
    </div>
  )
}

function MiniTool({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded border border-white/8 bg-white/[0.045] px-2 py-1.5 text-[10px] text-muted-foreground">
      <span className="text-foreground/80">{icon}</span>
      <span className="truncate">{label}</span>
    </div>
  )
}

function MockField({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="mb-2 rounded-md border border-white/10 bg-white/[0.035] px-2.5 py-2">
      <div className="text-[9px] uppercase text-muted-foreground/70">{label}</div>
      <div className={cn('mt-1 truncate text-[12px]', accent ? 'text-primary' : 'text-foreground/90')}>{value}</div>
    </div>
  )
}
