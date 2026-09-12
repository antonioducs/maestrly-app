/** ProseMirror search and replacement. Decorations track matches without changing document content;
 * React controls communicate with the plugin through transaction metadata. */
import { Plugin, PluginKey, type Transaction } from '@milkdown/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view'
import type { Node as ProseNode } from '@milkdown/prose/model'

export interface SearchOpts {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface SearchSnapshot {
  count: number
  current: number
  error: string | null
}

interface Match {
  from: number
  to: number
}

interface SearchState {
  query: string
  opts: SearchOpts
  matches: Match[]
  current: number
  error: string | null
  deco: DecorationSet
}

const EMPTY: SearchState = {
  query: '',
  opts: { caseSensitive: false, wholeWord: false, regex: false },
  matches: [],
  current: -1,
  error: null,
  deco: DecorationSet.empty,
}

export const notesSearchKey = new PluginKey<SearchState>('notes-search')

// ---- Metadata (React to plugin) -------------------------------------------------
type Meta =
  | { type: 'set'; query: string; opts: SearchOpts }
  | { type: 'clear' }
  | { type: 'go'; dir: 1 | -1 }
  | { type: 'afterReplace'; anchor: number }
  | { type: 'afterReplaceAll' }

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildRegex(query: string, opts: SearchOpts): RegExp {
  let src = opts.regex ? query : escapeRegExp(query)
  let flags = 'g' + (opts.caseSensitive ? '' : 'i')
  if (opts.wholeWord) {
    src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`
    flags += 'u'
  }
  return new RegExp(src, flags)
}

function findMatches(doc: ProseNode, re: RegExp): Match[] {
  const matches: Match[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ''
    const positions: number[] = []
    const flush = () => {
      if (!text) return
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (m.index === re.lastIndex) {
          re.lastIndex++
          continue
        }
        const start = m.index
        const end = m.index + m[0].length
        matches.push({ from: positions[start]!, to: positions[end - 1]! + 1 })
      }
      text = ''
      positions.length = 0
    }
    node.forEach((child, offset) => {
      const base = pos + 1 + offset
      if (child.isText) {
        const s = child.text ?? ''
        for (let i = 0; i < s.length; i++) {
          text += s[i]
          positions.push(base + i)
        }
      } else {
        const isBreak = child.type.name === 'hardbreak' || child.type.name === 'hard_break'
        if (isBreak) {
          text += '\n'
          positions.push(base)
        } else {
          flush()
        }
      }
    })
    flush()
    return false
  })
  return matches
}

function buildDeco(doc: ProseNode, matches: Match[], current: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === current ? 'notes-search-match notes-search-match--current' : 'notes-search-match',
    })
  )
  return DecorationSet.create(doc, decos)
}

type CurrentMode = { kind: 'reset' } | { kind: 'keep'; prev: number } | { kind: 'anchor'; pos: number }

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function compute(doc: ProseNode, query: string, opts: SearchOpts, mode: CurrentMode): SearchState {
  if (!query) return { ...EMPTY, query, opts }
  let re: RegExp
  try {
    re = buildRegex(query, opts)
  } catch (e) {
    return {
      query,
      opts,
      matches: [],
      current: -1,
      error: (e as Error).message || 'Invalid expression',
      deco: DecorationSet.empty,
    }
  }
  const matches = findMatches(doc, re)
  let current = -1
  if (matches.length) {
    if (mode.kind === 'reset') current = 0
    else if (mode.kind === 'keep') current = clamp(mode.prev < 0 ? 0 : mode.prev, 0, matches.length - 1)
    else {
      const i = matches.findIndex((m) => m.from >= mode.pos)
      current = i >= 0 ? i : 0
    }
  }
  return { query, opts, matches, current, error: null, deco: buildDeco(doc, matches, current) }
}

function apply(tr: Transaction, value: SearchState): SearchState {
  const meta = tr.getMeta(notesSearchKey) as Meta | undefined
  if (meta) {
    switch (meta.type) {
      case 'set':
        return compute(tr.doc, meta.query, meta.opts, { kind: 'reset' })
      case 'clear':
        return EMPTY
      case 'go': {
        if (!value.matches.length) return value
        const n = value.matches.length
        const current = (value.current + meta.dir + n) % n
        return { ...value, current, deco: buildDeco(tr.doc, value.matches, current) }
      }
      case 'afterReplace':
        return compute(tr.doc, value.query, value.opts, { kind: 'anchor', pos: meta.anchor })
      case 'afterReplaceAll':
        return compute(tr.doc, value.query, value.opts, { kind: 'reset' })
    }
  }
  if (tr.docChanged && value.query) {
    return compute(tr.doc, value.query, value.opts, { kind: 'keep', prev: value.current })
  }
  return value
}

function toSnapshot(s: SearchState): SearchSnapshot {
  return { count: s.matches.length, current: s.matches.length ? s.current + 1 : 0, error: s.error }
}

export function notesSearchPlugin(onChange: (s: SearchSnapshot) => void): Plugin<SearchState> {
  return new Plugin<SearchState>({
    key: notesSearchKey,
    state: {
      init: () => EMPTY,
      apply: (tr, value) => apply(tr, value),
    },
    props: {
      decorations: (state) => notesSearchKey.getState(state)?.deco ?? DecorationSet.empty,
    },

    view: () => ({
      update: (view, prev) => {
        const a = notesSearchKey.getState(prev)
        const b = notesSearchKey.getState(view.state)
        if (!b) return
        if (!a || a.matches.length !== b.matches.length || a.current !== b.current || a.error !== b.error) {
          onChange(toSnapshot(b))
        }
      },
    }),
  })
}

// ---- Commands (React to plugin) ----------------------------------------------

function scrollToCurrent(view: EditorView): void {
  const s = notesSearchKey.getState(view.state)
  if (!s || s.current < 0) return
  const m = s.matches[s.current]
  if (!m) return
  let coords: { top: number; bottom: number }
  try {
    coords = view.coordsAtPos(m.from)
  } catch {
    return
  }
  const scroller = view.dom.closest('.milkdown') as HTMLElement | null
  if (!scroller) return
  const box = scroller.getBoundingClientRect()
  const margin = 48
  if (coords.top < box.top + margin) scroller.scrollTop -= box.top + margin - coords.top
  else if (coords.bottom > box.bottom - margin) scroller.scrollTop += coords.bottom - (box.bottom - margin)
}

export function setSearch(view: EditorView, query: string, opts: SearchOpts): void {
  view.dispatch(
    view.state.tr.setMeta(notesSearchKey, { type: 'set', query, opts } satisfies Meta).setMeta('addToHistory', false)
  )
  scrollToCurrent(view)
}

export function clearSearch(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(notesSearchKey, { type: 'clear' } satisfies Meta).setMeta('addToHistory', false))
}

export function goToMatch(view: EditorView, dir: 1 | -1): void {
  view.dispatch(
    view.state.tr.setMeta(notesSearchKey, { type: 'go', dir } satisfies Meta).setMeta('addToHistory', false)
  )
  scrollToCurrent(view)
}

export function replaceCurrent(view: EditorView, replacement: string): void {
  const s = notesSearchKey.getState(view.state)
  if (!s || s.current < 0) return
  const m = s.matches[s.current]
  if (!m) return
  const tr = view.state.tr.insertText(replacement, m.from, m.to)
  tr.setMeta(notesSearchKey, { type: 'afterReplace', anchor: m.from + replacement.length } satisfies Meta)
  view.dispatch(tr)
  scrollToCurrent(view)
}

export function replaceAll(view: EditorView, replacement: string): void {
  const s = notesSearchKey.getState(view.state)
  if (!s || !s.matches.length) return
  const tr = view.state.tr
  for (let i = s.matches.length - 1; i >= 0; i--) {
    const m = s.matches[i]!
    tr.insertText(replacement, m.from, m.to)
  }
  tr.setMeta(notesSearchKey, { type: 'afterReplaceAll' } satisfies Meta)
  view.dispatch(tr)
}
