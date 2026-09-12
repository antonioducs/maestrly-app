/** Contenteditable composer with structured file and agent mentions.
 * Preserve mention identities, caret placement, and IME composition across React updates. */
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { FileCode, Folder, Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { findMentions } from '../../../shared/chat-mentions'
import { validateStructuredAgentMentions, type StructuredAgentMentionDraft } from '../../../shared/chat-agent-mentions'
import { normalizeSubagentProfileKey, type SubagentAgentDto } from '../../../shared/subagent-profiles'
import type { ChatFileHit } from '../../../shared/chat'

export interface MentionEditorHandle {
  serialize(): { text: string; mentions: StructuredAgentMentionDraft[] }

  focus(): void
}

export interface MentionEditorProps {
  value: string
  onChange: (text: string) => void
  onMentionsChange?: (mentions: StructuredAgentMentionDraft[]) => void
  structuredAgentMentions?: StructuredAgentMentionDraft[]

  agents: SubagentAgentDto[] | null
  disabled?: boolean
  placeholder?: string
  className?: string
  maxHeight?: number

  onSearchFiles?: (query: string) => Promise<ChatFileHit[]>
  /** Optional handler for opening a file chip. */
  onOpenMention?: (path: string, startLine?: number, endLine?: number) => void

  onAddFiles?: (files: File[]) => void

  onRequestSubmit?: () => void

  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => boolean
  /** Focus the inline editor and place the caret at the end on mount. */
  autoFocus?: boolean
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const FILE_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>'
const FOLDER_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>'
const BOT_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>'

function makeChip(t: TFunction<'chat'>, path: string, startLine?: number, endLine?: number): HTMLSpanElement {
  const span = document.createElement('span')
  span.dataset.mention = path
  if (startLine) span.dataset.sl = String(startLine)
  if (endLine) span.dataset.el = String(endLine)
  span.contentEditable = 'false'
  span.className =
    'mx-0.5 inline-flex cursor-pointer select-none items-center gap-1 rounded-md border border-sky-400/25 bg-sky-400/[0.14] px-1.5 py-0.5 align-middle text-[13px] text-sky-300 hover:bg-sky-400/[0.2]'
  const isDir = path.endsWith('/')
  const clean = path.replace(/\/+$/, '')
  const base = clean.split('/').pop() || clean
  const label = startLine ? `${base}:L${startLine}${endLine && endLine !== startLine ? '-' + endLine : ''}` : base
  span.title = t('composer.chipOpenTitle', { path: clean })
  span.innerHTML =
    `<span class="shrink-0">${isDir ? FOLDER_SVG : FILE_SVG}</span>` +
    `<span class="max-w-[220px] truncate">${escapeHtml(label)}</span>` +
    `<span data-x title="${escapeHtml(t('composer.remove'))}" class="ml-0.5 rounded px-0.5 text-sky-300/70 hover:bg-sky-400/25 hover:text-sky-100">×</span>`
  return span
}

function makeAgentChip(t: TFunction<'chat'>, agent: SubagentAgentDto, id: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.dataset.agentMention = agent.name
  span.dataset.agentMentionId = id
  span.contentEditable = 'false'
  span.className =
    'mx-0.5 inline-flex cursor-pointer select-none items-center gap-1 rounded-md border border-indigo-400/25 bg-indigo-400/[0.14] px-1.5 py-0.5 align-middle text-[13px] text-indigo-300 hover:bg-indigo-400/[0.2]'
  span.title = agent.virtual ? t('composer.agentChipVirtual', { name: agent.name }) : agent.description || agent.name
  span.innerHTML =
    `<span class="shrink-0">${BOT_SVG}</span>` +
    `<span class="max-w-[220px] truncate">${escapeHtml(agent.name)}</span>` +
    `<span data-x title="${escapeHtml(t('composer.remove'))}" class="ml-0.5 rounded px-0.5 text-indigo-300/70 hover:bg-indigo-400/25 hover:text-indigo-100">×</span>`
  return span
}

function insertChipAt(
  editor: HTMLElement,
  node: Text,
  atOffset: number,
  trigger: '@' | '#',
  chip: HTMLSpanElement
): void {
  const parent = node.parentNode
  if (!parent) return
  const full = node.textContent ?? ''
  const beforeAt = full.slice(0, atOffset)
  const tokenRest = new RegExp(`[^\\s${trigger}]*`).exec(full.slice(atOffset + 1))?.[0] ?? ''
  const after = full.slice(atOffset + 1 + tokenRest.length)
  const space = document.createTextNode(' ' + after)
  if (beforeAt) parent.insertBefore(document.createTextNode(beforeAt), node)
  parent.insertBefore(chip, node)
  parent.insertBefore(space, node)
  parent.removeChild(node)
  const range = document.createRange()
  range.setStart(space, 1)
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  editor.focus()
}

function serializeWithMentions(root: HTMLElement): { text: string; mentions: StructuredAgentMentionDraft[] } {
  let out = ''
  const mentions: StructuredAgentMentionDraft[] = []
  const walk = (node: Node): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent ?? ''
      } else if (child.nodeName === 'BR') {
        out += '\n'
      } else if (child instanceof HTMLElement && child.dataset.mention != null) {
        const p = child.dataset.mention
        const sl = child.dataset.sl
        const el = child.dataset.el
        out += '@' + p + (sl ? ':L' + sl + (el && el !== sl ? '-' + el : '') : '')
      } else if (child instanceof HTMLElement && child.dataset.agentMention != null) {
        const raw = child.dataset.agentMention
        const id = child.dataset.agentMentionId ?? ''
        const start = out.length
        out += '#' + raw
        const name = normalizeSubagentProfileKey(raw)
        if (id && name) mentions.push({ id, name, start, end: out.length })
      } else if (child instanceof HTMLElement && (child.nodeName === 'DIV' || child.nodeName === 'P')) {
        if (out && !out.endsWith('\n')) out += '\n'
        walk(child)
      } else {
        walk(child)
      }
    })
  }
  walk(root)

  if (root.lastChild?.nodeName === 'BR' && out.endsWith('\n')) out = out.slice(0, -1)
  return { text: out, mentions }
}

function renderValue(
  t: TFunction<'chat'>,
  root: HTMLElement,
  text: string,
  agents: readonly SubagentAgentDto[] | null,
  structured: readonly StructuredAgentMentionDraft[]
): void {
  root.replaceChildren()
  const frag = document.createDocumentFragment()
  const pushText = (s: string) => {
    if (s) frag.appendChild(document.createTextNode(s))
  }
  const byIndex = new Map<number, { end: number; el: Node }>()
  for (const m of findMentions(text)) {
    byIndex.set(m.index, { end: m.index + m.raw.length, el: makeChip(t, m.path, m.startLine, m.endLine) })
  }
  if (agents === null) {
    for (const m of structured) {
      if (!m || typeof m.id !== 'string' || !m.id || typeof m.name !== 'string') continue
      if (typeof m.start !== 'number' || typeof m.end !== 'number') continue
      if (m.start < 0 || m.end > text.length || m.end <= m.start) continue
      const slice = text.slice(m.start, m.end)
      if (!slice.startsWith('#')) continue
      const stub: SubagentAgentDto = {
        name: m.name,
        description: m.name,
        source: 'loading',
      }
      byIndex.set(m.start, { end: m.end, el: makeAgentChip(t, stub, m.id) })
    }
  } else {
    const available = new Map(agents.map((a) => [normalizeSubagentProfileKey(a.name), a]))
    for (const m of validateStructuredAgentMentions(
      structured,
      text,
      agents.map((a) => a.name)
    )) {
      const agent = available.get(m.name)
      if (!agent) continue
      byIndex.set(m.start, { end: m.end, el: makeAgentChip(t, agent, m.id) })
    }
  }
  let last = 0
  for (const [index, { end, el }] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    if (index < last) continue
    pushText(text.slice(last, index))
    frag.appendChild(el)
    last = end
  }
  pushText(text.slice(last))
  root.appendChild(frag)
}

function focusEditorAtEnd(el: HTMLDivElement): void {
  try {
    el.focus({ preventScroll: true })
  } catch {
    el.focus()
  }
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

export const MentionEditor = forwardRef<MentionEditorHandle, MentionEditorProps>(function MentionEditor(
  {
    value,
    onChange,
    onMentionsChange,
    structuredAgentMentions = [],
    agents,
    disabled,
    placeholder,
    className,
    maxHeight,
    onSearchFiles,
    onOpenMention,
    onAddFiles,
    onRequestSubmit,
    onKeyDown,
    autoFocus,
  },
  ref
) {
  const { t } = useTranslation('chat')
  const editorRef = useRef<HTMLDivElement>(null)
  const lastValueRef = useRef<string>('')
  const lastAgentsRef = useRef<string>('')
  const composingRef = useRef(false) // IME composition is active.

  type ComposerMention =
    | { kind: 'file'; query: string; node: Text; atOffset: number }
    | { kind: 'agent'; query: string; node: Text; atOffset: number }
  const [mention, setMention] = useState<ComposerMention | null>(null)
  const [hits, setHits] = useState<ChatFileHit[]>([])
  const [activeIdx, setActiveIdx] = useState(0)

  useImperativeHandle(ref, () => ({
    serialize: () => {
      const el = editorRef.current
      if (!el) return { text: value, mentions: [] }
      return serializeWithMentions(el)
    },
    focus: () => {
      const el = editorRef.current
      if (el) focusEditorAtEnd(el)
    },
  }))

  const agentQuery = mention?.kind === 'agent' ? mention.query : null
  const agentHits = useMemo(() => {
    if (agentQuery === null || agents === null || agents.length === 0) return []
    const q = agentQuery.toLowerCase()
    const matches = agents.filter((agent) => {
      const name = agent.name.toLowerCase()
      return (
        name.startsWith(q) ||
        name.includes(q) ||
        agent.description.toLowerCase().includes(q) ||
        (agent.category?.toLowerCase().includes(q) ?? false)
      )
    })
    return matches.sort((x, y) => {
      const xp = x.name.toLowerCase().startsWith(q) ? 0 : 1
      const yp = y.name.toLowerCase().startsWith(q) ? 0 : 1
      return xp - yp || x.name.localeCompare(y.name)
    })
  }, [agentQuery, agents])
  const agentMenuOpen = mention?.kind === 'agent' && agentHits.length > 0

  // Keep structured agent mentions stable when chips rerender after save, clear, or toggle.

  const agentsKey = useMemo(() => (agents === null ? '\0loading' : agents.map((a) => a.name).join('\0')), [agents])

  const structuredMentions = useMemo(
    () => (Array.isArray(structuredAgentMentions) ? structuredAgentMentions : []),
    [structuredAgentMentions]
  )
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (value === lastValueRef.current && agentsKey === lastAgentsRef.current) return
    renderValue(t, el, value, agents, structuredMentions)
    lastValueRef.current = value
    lastAgentsRef.current = agentsKey

    if (agents !== null) {
      onMentionsChange?.(serializeWithMentions(el).mentions)
    }
    // Move the caret to the end when focused.
    if (document.activeElement === el) {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [value, t, agents, agentsKey, structuredMentions, onMentionsChange])

  const emitChange = () => {
    if (composingRef.current) return
    const el = editorRef.current
    if (!el) return
    const { text, mentions } = serializeWithMentions(el)
    if (text === '' && el.innerHTML !== '') el.replaceChildren()
    lastValueRef.current = text
    onChange(text)

    onMentionsChange?.(mentions)
  }

  const detectMention = () => {
    if (composingRef.current) return
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || !sel.anchorNode || sel.anchorNode.nodeType !== Node.TEXT_NODE) {
      setMention(null)
      return
    }
    const node = sel.anchorNode as Text
    if (!editorRef.current?.contains(node)) {
      setMention(null)
      return
    }
    const before = (node.textContent ?? '').slice(0, sel.anchorOffset)
    const file = /(?:^|\s)@([^\s@]*)$/.exec(before)
    if (file) {
      setMention({ kind: 'file', query: file[1], node, atOffset: before.lastIndexOf('@') })
      return
    }

    if (agents !== null) {
      const agent = /(?:^|\s)#([^\s#]*)$/.exec(before)

      if (agent && (agent[1] === '' || /^[A-Za-z]/.test(agent[1]))) {
        setMention({ kind: 'agent', query: agent[1], node, atOffset: before.lastIndexOf('#') })
        return
      }
    }
    setMention(null)
  }

  const mentionFileQuery = mention?.kind === 'file' ? mention.query : null
  useEffect(() => {
    if (mentionFileQuery === null || !onSearchFiles) {
      setHits([])
      return
    }
    let alive = true
    onSearchFiles(mentionFileQuery).then((r) => {
      if (alive) {
        setHits(r)
        setActiveIdx(0)
      }
    })
    return () => {
      alive = false
    }
  }, [mentionFileQuery, onSearchFiles])

  useEffect(() => setActiveIdx(0), [mention?.kind, mention?.query])

  const pickHit = (hit: ChatFileHit | undefined) => {
    if (mention?.kind !== 'file' || !hit) return
    const editor = editorRef.current
    if (!editor || !mention.node.parentNode) {
      setMention(null)
      return
    }

    const chipPath = hit.path.includes('/') || hit.path.includes('.') ? hit.path : './' + hit.path
    insertChipAt(editor, mention.node, mention.atOffset, '@', makeChip(t, chipPath, undefined, undefined))
    setMention(null)
    setHits([])
    emitChange()
  }

  const pickAgent = (agent: SubagentAgentDto | undefined) => {
    if (mention?.kind !== 'agent' || !agent) return
    const editor = editorRef.current
    if (!editor || !mention.node.parentNode) {
      setMention(null)
      return
    }

    insertChipAt(editor, mention.node, mention.atOffset, '#', makeAgentChip(t, agent, crypto.randomUUID()))
    setMention(null)
    emitChange()
  }

  const insertTextAtCaret = (text: string) => {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const node = document.createTextNode(text)
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const insertLineBreak = () => {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const br = document.createElement('br')
    range.insertNode(br)
    const next = br.nextSibling
    const atEnd = !next || (next.nodeType === Node.TEXT_NODE && next.textContent === '')
    if (atEnd) {
      const anchor = document.createElement('br')
      br.after(anchor)
      range.setStartBefore(anchor)
    } else {
      range.setStartAfter(br)
    }
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const onEditorClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    const chip = target.closest('[data-mention], [data-agent-mention]') as HTMLElement | null
    if (!chip) return
    e.preventDefault()
    if (target.closest('[data-x]')) {
      const next = chip.nextSibling
      chip.remove()

      if (next && next.nodeType === Node.TEXT_NODE && next.textContent?.startsWith(' ')) {
        next.textContent = next.textContent.slice(1)
      }
      emitChange()
      return
    }
    const p = (chip.dataset.mention ?? '').replace(/\/+$/, '')
    if (p)
      onOpenMention?.(
        p,
        chip.dataset.sl ? Number(chip.dataset.sl) : undefined,
        chip.dataset.el ? Number(chip.dataset.el) : undefined
      )
  }

  useEffect(() => {
    if (!autoFocus) return
    const el = editorRef.current
    if (!el) return
    focusEditorAtEnd(el)
  }, [autoFocus])

  const menuOpen = mention?.kind === 'file' && hits.length > 0

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(i + 1, hits.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (
        (e.key === 'Enter' && !e.shiftKey) ||
        (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)
      ) {
        e.preventDefault()
        pickHit(hits[activeIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    } else if (agentMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(i + 1, agentHits.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (
        (e.key === 'Enter' && !e.shiftKey) ||
        (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)
      ) {
        e.preventDefault()
        pickAgent(agentHits[activeIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }

    if (onKeyDown?.(e) === true) return
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
      e.preventDefault()
      onRequestSubmit?.()
      return
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      insertLineBreak()
      emitChange()
    }
  }

  return (
    <div className="relative">
      {menuOpen && (
        <div className="absolute bottom-full left-3 z-50 mb-1 max-h-64 w-80 overflow-auto rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl">
          {hits.map((h, i) => (
            <button
              key={h.path}
              type="button"
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pickHit(h)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                i === activeIdx ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
              )}
            >
              {h.kind === 'dir' ? (
                <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400/70" />
              ) : (
                <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-[13px] text-foreground">{h.name}</span>
              <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground">{h.path}</span>
            </button>
          ))}
        </div>
      )}

      {agentMenuOpen && (
        <div className="absolute bottom-full left-3 z-50 mb-1 max-h-64 w-80 overflow-auto rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl">
          {agentHits.map((agent, i) => (
            <button
              key={agent.name}
              type="button"
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pickAgent(agent)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                i === activeIdx ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
              )}
            >
              <Bot className="h-3.5 w-3.5 shrink-0 text-indigo-400/70" />
              <span className="truncate text-[13px] text-foreground">{agent.name}</span>
              {agent.virtual && (
                <span className="shrink-0 rounded bg-indigo-400/15 px-1 py-px text-[10px] uppercase tracking-wide text-indigo-300">
                  {t('composer.agentVirtualBadge')}
                </span>
              )}
              <span className="ml-auto max-w-[130px] shrink-0 truncate text-[11px] text-muted-foreground">
                {agent.description}
              </span>
            </button>
          ))}
        </div>
      )}

      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={() => {
          emitChange()
          detectMention()
        }}
        onKeyUp={detectMention}
        onClick={onEditorClick}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('[data-mention], [data-agent-mention]')) e.preventDefault()
        }}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          emitChange()
          detectMention()
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files ?? [])
          if (files.length && onAddFiles) {
            e.preventDefault()
            onAddFiles(files)
            return
          }
          e.preventDefault()
          insertTextAtCaret(e.clipboardData?.getData('text/plain') ?? '')
          emitChange()
          detectMention()
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          'min-h-[3rem] w-full whitespace-pre-wrap break-words px-1 py-0.5 text-[15px] leading-relaxed text-foreground outline-none',
          disabled && 'opacity-60',
          className
        )}
        style={maxHeight ? { maxHeight } : undefined}
      />
    </div>
  )
})
