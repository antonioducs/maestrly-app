import { Settings2, Sparkles } from 'lucide-react'
import { cn } from '@maestrly/ui'
import { useChatUi } from '../provider'
import { PANEL_CLASS, usePopover } from './usePopover'

export interface SkillToggle {
  name: string
  description: string
  enabled: boolean
}

/** Skills available to this conversation, each switchable on or off. */
export function ChatSkillsMenu({
  skills,
  onToggle,
  onOpenSettings,
  emptyText,
  disabled = false,
}: {
  skills: SkillToggle[]
  onToggle: (name: string, enabled: boolean) => void
  onOpenSettings?: () => void
  emptyText?: string
  disabled?: boolean
}) {
  const { labels } = useChatUi()
  const { open, setOpen, ref } = usePopover()
  const active = skills.filter((skill) => skill.enabled).length
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-skills-menu
        onClick={() => setOpen((value) => !value)}
        title={labels.composer.skills}
        className={cn(
          'flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground',
          active > 0 && 'text-violet-300'
        )}
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span className="tabular-nums">{active}</span>
      </button>
      {open && (
        <div role="dialog" aria-label={labels.composer.skills} className={cn(PANEL_CLASS, 'max-h-[28rem] w-80 overflow-auto')}>
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{labels.composer.skills}</div>
            {onOpenSettings && (
              <button type="button" onClick={onOpenSettings} className="text-muted-foreground hover:text-foreground" title={labels.composer.skills}>
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {skills.length === 0 && <p className="px-2.5 py-2 text-[11px] text-muted-foreground">{emptyText ?? '—'}</p>}
          {skills.map((skill) => (
            <label key={skill.name} className="flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-1.5 hover:bg-white/[0.04]">
              <input
                type="checkbox"
                checked={skill.enabled}
                disabled={disabled}
                onChange={(event) => onToggle(skill.name, event.target.checked)}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[12px] text-foreground">/{skill.name}</span>
                {skill.description && <span className="block truncate text-[11px] text-muted-foreground">{skill.description}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
