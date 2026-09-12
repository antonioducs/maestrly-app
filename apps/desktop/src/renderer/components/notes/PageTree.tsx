import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, FileText, Plus, Trash2, PanelLeftClose } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PageMeta } from '../../../preload'

interface Props {
  pages: PageMeta[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: (parentId: string | null) => void
  onDelete: (id: string) => void
  onMove: (id: string, parentId: string | null, order: number) => void
  onCollapse?: () => void
}

type DropPos = 'before' | 'after' | 'child'

export function PageTree({ pages, selectedId, onSelect, onCreate, onDelete, onMove, onCollapse }: Props) {
  const { t } = useTranslation('ui')
  const byParent = useMemo(() => {
    const m = new Map<string | null, PageMeta[]>()
    for (const p of pages) {
      const arr = m.get(p.parentId) ?? []
      arr.push(p)
      m.set(p.parentId, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => a.order - b.order)
    return m
  }, [pages])

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const dragId = useRef<string | null>(null)
  const [hint, setHint] = useState<{ id: string; pos: DropPos } | null>(null)

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  function applyDrop(from: string, h: { id: string; pos: DropPos }) {
    const target = pages.find((p) => p.id === h.id)
    if (!target || from === target.id) return
    if (h.pos === 'child') {
      setCollapsed((s) => {
        if (!s.has(target.id)) return s
        const n = new Set(s)
        n.delete(target.id)
        return n
      })
      onMove(from, target.id, byParent.get(target.id)?.length ?? 0)
    } else onMove(from, target.parentId, h.pos === 'before' ? target.order : target.order + 1)
  }

  function Row({ page, depth }: { page: PageMeta; depth: number }) {
    const children = byParent.get(page.id) ?? []
    const isOpen = !collapsed.has(page.id)
    const dragging = dragId.current === page.id
    return (
      <>
        <div
          draggable
          onDragStart={(e) => {
            dragId.current = page.id
            e.dataTransfer.effectAllowed = 'move'
            try {
              e.dataTransfer.setData('text/plain', page.id)
            } catch {
              /* no-op */
            }
          }}
          onDragOver={(e) => {
            if (!dragId.current || dragId.current === page.id) return
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            const y = e.clientY - r.top
            const pos: DropPos = y < r.height * 0.3 ? 'before' : y > r.height * 0.7 ? 'after' : 'child'
            setHint((h) => (h?.id === page.id && h.pos === pos ? h : { id: page.id, pos }))
          }}
          onDrop={(e) => {
            e.preventDefault()
            const from = dragId.current
            const h = hint
            dragId.current = null
            setHint(null)
            if (from && h) applyDrop(from, h)
          }}
          onDragEnd={() => {
            dragId.current = null
            setHint(null)
          }}
          onClick={() => onSelect(page.id)}
          style={{ paddingLeft: depth * 12 + 6 }}
          className={cn(
            'group relative flex items-center gap-1 rounded-md py-1 pr-1 text-sm cursor-pointer',
            page.id === selectedId ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:bg-white/[0.04]',
            dragging && 'opacity-40',
            hint?.id === page.id && hint.pos === 'child' && 'ring-1 ring-primary/70',
            hint?.id === page.id && hint.pos === 'before' && 'shadow-[inset_0_2px_0_0_var(--color-primary)]',
            hint?.id === page.id && hint.pos === 'after' && 'shadow-[inset_0_-2px_0_0_var(--color-primary)]'
          )}
        >
          {children.length > 0 ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggle(page.id)
              }}
              className="flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <span className="shrink-0 text-sm leading-none">
            {page.emoji ?? <FileText className="size-3.5 opacity-70" />}
          </span>
          <span className="flex-1 truncate">{page.title || t('pageTree.untitled')}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onCreate(page.id)
            }}
            title={t('pageTree.newSubpage')}
            className="hidden size-5 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.08] hover:text-foreground group-hover:flex"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete(page.id)
            }}
            title={t('pageTree.deleteSubtree')}
            className="hidden size-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:flex"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
        {isOpen && children.map((c) => <Row key={c.id} page={c} depth={depth + 1} />)}
      </>
    )
  }

  const roots = byParent.get(null) ?? []
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('pageTree.pages')}</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => onCreate(null)}
            title={t('pageTree.newPage')}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
          >
            <Plus className="size-4" />
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              title={t('pageTree.collapse')}
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
            >
              <PanelLeftClose className="size-4" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1 pb-2">
        {roots.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">{t('pageTree.empty')}</p>
        ) : (
          roots.map((p) => <Row key={p.id} page={p} depth={0} />)
        )}
      </div>
    </div>
  )
}
