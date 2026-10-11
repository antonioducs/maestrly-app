import { useTranslation } from 'react-i18next'

export type BotPane = 'chat' | 'computer'

/**
 * Narrow windows show one pane at a time: a compact switch between the main pane and the screen. A bot's are its
 * conversation and its computer; an environment names its own with `labels`.
 */
export function BotPaneSwitch({
  active,
  onChange,
  labels,
}: {
  active: BotPane
  onChange: (pane: BotPane) => void
  labels?: { group: string; chat: string; computer: string }
}) {
  const { t } = useTranslation('fleet')
  const names = labels ?? {
    group: t('workspace.panes'),
    chat: t('workspace.chatPane'),
    computer: t('workspace.computerPane'),
  }
  return (
    <div
      role="group"
      aria-label={names.group}
      className="flex shrink-0 gap-0.5 rounded-[9px] border border-border p-0.5"
    >
      {(['chat', 'computer'] as const).map((pane) => (
        <button
          key={pane}
          type="button"
          aria-pressed={active === pane}
          onClick={() => onChange(pane)}
          className={`h-[26px] rounded-[7px] px-2.5 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active === pane ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {names[pane]}
        </button>
      ))}
    </div>
  )
}
