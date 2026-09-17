import type { ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { cn } from '@maestrly/ui'
import { PANEL_CLASS, usePopover } from './usePopover'

export interface PlusMenuItem {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
}

/** The "+" menu: a plain list of actions the host application provides. */
export function ChatPlusMenu({ items, title, children }: { items: PlusMenuItem[]; title?: string; children?: ReactNode }) {
  const { open, setOpen, ref } = usePopover()
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-plus-menu
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
        title={title}
      >
        <Plus className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className={cn(PANEL_CLASS, 'w-72')}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-foreground hover:bg-white/[0.05] disabled:opacity-50"
            >
              {item.icon && <span className="shrink-0 text-muted-foreground">{item.icon}</span>}
              <span className="min-w-0">
                <span className="block">{item.label}</span>
                {item.description && <span className="block truncate text-[11px] text-muted-foreground">{item.description}</span>}
              </span>
            </button>
          ))}
          {children}
        </div>
      )}
    </div>
  )
}
