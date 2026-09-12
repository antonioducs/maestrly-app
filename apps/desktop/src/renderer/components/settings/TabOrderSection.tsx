import type { ReactNode } from 'react'
import {
  ClipboardList,
  Code2,
  GitPullRequest,
  Globe,
  GripVertical,
  MessageCircle,
  PanelRight,
  RotateCw,
  SquareTerminal,
  StickyNote,
} from 'lucide-react'
import type { useReorder } from '@/lib/use-reorder'
import type { DrawerTab } from '@/lib/drawer-tabs'
import { cn } from '@/lib/utils'
import type { TFn } from './shared'

const TAB_ICON: Record<DrawerTab, ReactNode> = {
  browser: <Globe className="size-4" />,
  vscode: <Code2 className="size-4" />,
  terminal: <SquareTerminal className="size-4" />,
  plan: <ClipboardList className="size-4" />,
  review: <GitPullRequest className="size-4" />,
  notes: <StickyNote className="size-4" />,
  chatgpt: <MessageCircle className="size-4" />,
}

export function TabOrderSection({
  t,
  tabOrder,
  tabDragProps,
  tabOverIndex,
  resetTabOrder,
}: {
  t: TFn
  tabOrder: DrawerTab[]
  tabDragProps: ReturnType<typeof useReorder>['props']
  tabOverIndex: number | null
  resetTabOrder: () => void
}) {
  const tabLabel: Record<DrawerTab, string> = {
    browser: t('drawer.tabBrowser'),
    vscode: t('drawer.tabCode'),
    terminal: t('drawer.tabTerminal'),
    plan: t('drawer.tabPlan'),
    review: t('drawer.tabReview'),
    notes: t('drawer.tabNotes'),
    chatgpt: t('drawer.tabChatGpt'),
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <PanelRight className="size-4 text-muted-foreground" /> {t('settings.tabs.heading')}
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.tabs.desc')}</p>
        </div>
        <button
          type="button"
          onClick={resetTabOrder}
          className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          title={t('settings.tabs.reset')}
        >
          <RotateCw className="size-3" />
          {t('settings.tabs.reset')}
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {tabOrder.map((key, i) => (
          <div
            key={key}
            {...tabDragProps(i)}
            className={cn(
              'flex cursor-grab items-center gap-2.5 rounded-lg border bg-white/[0.02] px-3 py-2.5 transition-colors active:cursor-grabbing',
              tabOverIndex === i ? 'border-primary/50 bg-primary/10' : 'border-border'
            )}
          >
            <GripVertical className="size-4 shrink-0 text-muted-foreground/50" />
            <span className="shrink-0 text-muted-foreground">{TAB_ICON[key]}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{tabLabel[key]}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">{i + 1}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
