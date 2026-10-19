import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import { Button } from '@/components/ui/button'
import { ShellTerminalView } from '@/components/ShellTerminalView'
import { useReorder } from '@/components/useReorder'
import { instanceBadgeStyle } from '../../shared/instance-color'

interface TermTab {
  id: string
  cwd: string
  label?: string
}

export function TerminalTabs({ convId, active = true }: { convId: string; active?: boolean }) {
  const { t: tr } = useTranslation('ui')
  const api = useHostApi()
  const [terminals, setTerminals] = useState<TermTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [termTitles, setTermTitles] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const initialTerminalHandled = useRef(false)
  const reorder = useReorder((f, t) => api.drawerReorderTerminal(convId, f, t))
  const handleOscTitle = useCallback((id: string, title: string) => {
    setTermTitles((prev) => (prev[id] === title ? prev : { ...prev, [id]: title }))
  }, [])

  const createTerminal = useCallback(() => {
    api.drawerCreateTerminal(convId)
  }, [convId, api])

  useEffect(() => {
    let alive = true
    void api.getTerminalState(convId).then((s) => {
      if (!alive) return
      setTerminals(s.terminals)
      setActiveId(s.activeId)
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [convId, api])

  useEffect(() => {
    return api.onTerminalState((s) => {
      if (s.convId !== convId) return
      setTerminals(s.terminals)
      setActiveId(s.activeId)
    })
  }, [convId, api])

  useEffect(() => {
    if (!loaded || initialTerminalHandled.current) return
    initialTerminalHandled.current = true
    if (terminals.length === 0) api.drawerCreateTerminal(convId)
  }, [loaded, convId, terminals.length, api])

  // Cmd/Ctrl+T and W of a remote host's terminals: main catches them and this panel runs them on the host.
  useEffect(
    () =>
      window.api.onTerminalShortcut((action) => {
        if (action === 'create') api.drawerCreateTerminal(convId)
        else if (activeId) api.drawerCloseTerminal(convId, activeId)
      }),
    [convId, api, activeId]
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
        {terminals.map((t, i) => {
          const active = t.id === activeId

          const inst = termTitles[t.id]?.match(/(?:◆\s*)?DEV\s*·\s*([a-zA-Z0-9][a-zA-Z0-9-]*)/)?.[1]
          const badgeStyle = inst ? instanceBadgeStyle(inst) : undefined
          const tabLabel = inst ? `DEV · ${inst}` : (t.label ?? tr('terminalTabs.terminalN', { n: i + 1 }))
          return (
            <div
              key={t.id}
              {...reorder.props(i)}
              onClick={() => api.drawerSetActiveTerminal(convId, t.id)}
              className={cn(
                'group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs',
                inst
                  ? cn('border', active && 'ring-1 ring-primary/70')
                  : active
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/50',
                reorder.overIndex === i && 'ring-1 ring-primary/60'
              )}
              style={badgeStyle}
            >
              <span>{tabLabel}</span>
              <X
                className="size-3 shrink-0 opacity-0 hover:text-destructive group-hover:opacity-60"
                onClick={(e) => {
                  e.stopPropagation()
                  api.drawerCloseTerminal(convId, t.id)
                }}
              />
            </div>
          )
        })}
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={createTerminal}
          title={tr('terminalTabs.newTerminal')}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {terminals.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <span>{tr('terminalTabs.noTerminals')}</span>
            <Button variant="outline" size="sm" onClick={createTerminal}>
              <Plus className="size-3.5" />
              {tr('terminalTabs.newTerminal')}
            </Button>
          </div>
        )}
        {(() => {
          const activeTerminal = active ? (terminals.find((t) => t.id === activeId) ?? terminals[0]) : null
          if (!activeTerminal) return null
          return (
            <div key={activeTerminal.id} className="absolute inset-0">
              <ShellTerminalView agentId={activeTerminal.id} onOscTitle={handleOscTitle} visible />
            </div>
          )
        })()}
      </div>
    </div>
  )
}
