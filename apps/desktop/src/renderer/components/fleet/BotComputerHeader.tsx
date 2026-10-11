import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Maximize2, Minimize2, Monitor, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetScreenSurface } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { botFirstName } from '@/lib/fleet/format'
import { nextRadioIndex } from '@/lib/fleet/forms'
import { BotIdentity } from './BotChatHeader'
import { BotPaneSwitch, type BotPane } from './BotPaneSwitch'

const surfaces = ['browser', 'apps'] as const

/**
 * Browser or Apps, for an environment whose image keeps them as separate areas of the screen. An image from before
 * environments has only its browser: Apps stays visible, disabled, and `describedBy` says why.
 */
export function ScreenSurfaceToggle({
  value,
  appsDisabled,
  describedBy,
  title,
  onChange,
}: {
  value: FleetScreenSurface
  appsDisabled: boolean
  describedBy?: string
  title?: string
  onChange: (surface: FleetScreenSurface) => void
}) {
  const { t } = useTranslation('fleet')
  const radios = useRef<Array<HTMLButtonElement | null>>([])
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextRadioIndex(index, event.key, surfaces.length)
    if (next === null) return
    event.preventDefault()
    if (appsDisabled && surfaces[next] === 'apps') return
    onChange(surfaces[next])
    radios.current[next]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={t('screen.surface')}
      title={title}
      className="flex shrink-0 gap-0.5 rounded-[9px] border border-border p-0.5"
    >
      {surfaces.map((name, index) => (
        <button
          key={name}
          ref={(node) => {
            radios.current[index] = node
          }}
          type="button"
          role="radio"
          aria-checked={value === name}
          tabIndex={value === name ? 0 : -1}
          disabled={appsDisabled && name === 'apps'}
          aria-describedby={appsDisabled && name === 'apps' ? describedBy : undefined}
          onClick={() => onChange(name)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className={`h-[26px] rounded-[7px] px-2.5 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${value === name ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {name === 'browser' ? t('screen.browser') : t('screen.apps')}
        </button>
      ))}
    </div>
  )
}

/**
 * The computer's header: a chip that names it and closes it, what to maximize or switch, and — once the conversation
 * is out of sight, maximized or in a narrow window — whose computer this is.
 */
export function BotComputerHeader({
  bot,
  maximized,
  narrow,
  activePane,
  surfaceToggle,
  onShowPane,
  onMaximize,
  onRestore,
  onClose,
}: {
  bot: FleetBot
  maximized: boolean
  narrow: boolean
  activePane: BotPane
  /** The Browser/Apps choice of images without the unified desktop. */
  surfaceToggle?: ReactNode
  onShowPane: (pane: BotPane) => void
  onMaximize: () => void
  onRestore: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('fleet')
  const alone = maximized || narrow
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 pl-4 pr-3">
      {alone && <BotIdentity bot={bot} heading={false} />}
      <div className="inline-flex h-[34px] min-w-0 shrink-0 items-center gap-2 rounded-[10px] border border-border bg-white/[0.05] pl-3 pr-[5px] text-[13px]">
        <Monitor aria-hidden="true" className="size-4 shrink-0 text-foreground/75" />
        <span className="truncate">{t('workspace.chip', { name: botFirstName(bot.name) })}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('workspace.close')}
          title={t('workspace.close')}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {surfaceToggle}
        {narrow ? (
          <BotPaneSwitch active={activePane} onChange={onShowPane} />
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="size-[30px] text-muted-foreground hover:text-foreground"
            aria-label={t(maximized ? 'workspace.restore' : 'workspace.maximize')}
            title={t(maximized ? 'workspace.restore' : 'workspace.maximize')}
            onClick={maximized ? onRestore : onMaximize}
          >
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </Button>
        )}
      </div>
    </header>
  )
}
