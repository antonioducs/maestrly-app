import { createHash } from 'node:crypto'
import { z } from 'zod'
import { normalizeBundlePath } from './bundle-paths.js'
import type { TextEdit } from './edits.js'
import {
  DESIGN_MANIFEST_PATH,
  DESIGN_SCHEMA,
  MAX_DESIGN_CACHE_ENTRIES,
  MAX_DESIGN_SCREEN_NAME_CHARS,
  MAX_DESIGN_SCREEN_PATH_CHARS,
  MAX_DESIGN_SCREENS,
  MAX_DESIGN_TITLE_CHARS,
  MAX_DESIGN_TOKEN_FILES,
  MAX_DESIGN_TOKENS,
  MAX_EDITS,
  MAX_INSPECTED_TOKENS,
  MAX_INVENTORY_COMPONENTS,
  MAX_MANIFEST_BYTES,
  MAX_PATH_CHARS,
  MAX_TOKENS_FILE_BYTES,
  MAX_VIEWPORT_DIMENSION,
  MIN_VIEWPORT_DIMENSION,
} from './limits.js'
import {
  COMPONENT_NAME_PATTERN,
  isValidThemeSelector,
  isValidTokenName,
  isValidTokenValue,
  SCREEN_ID_PATTERN,
  TOKEN_NAME_PATTERN,
  type DesignManifest,
  type DesignScreen,
  type DesignToken,
  type TokenChange,
  type TokenSuggestionChange,
  type ViewerDesign,
} from './shell/contract.js'
import { classifyTokenValue, formatTokenSummary, groupOfToken, tokenDraftKey } from './shell/design-model.js'
import type { ArtifactStore } from './store/artifact-store.js'
import type { BlobStore } from './store/blobs.js'

export { formatTokenSummary }

export type DesignErrorCode = 'no_design_contract' | 'invalid_tokens' | 'unknown_token' | 'no_changes'

export class DesignActionError extends Error {
  constructor(
    public readonly code: DesignErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'DesignActionError'
  }
}

export interface ParsedTokenSpan {
  name: string
  theme: string | null
  value: string
  hadImportant: boolean
  blockStart: number
  blockEnd: number
  declStart: number
  declEnd: number
  valueStart: number
  valueEnd: number
}

export interface ParsedTokensCss {
  tokens: DesignToken[]
  themes: string[]
  canonicalNames: ReadonlySet<string>
  /** Keyed by `tokenDraftKey(name, theme)`. */
  spans: ReadonlyMap<string, ParsedTokenSpan>
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const cssTextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const viewportSchema = z.union([
  z.enum(['desktop', 'tablet', 'mobile']),
  z
    .object({
      width: z.number().int().min(MIN_VIEWPORT_DIMENSION).max(MAX_VIEWPORT_DIMENSION),
      height: z.number().int().min(MIN_VIEWPORT_DIMENSION).max(MAX_VIEWPORT_DIMENSION),
    })
    .strict(),
])

const screenSchema = z
  .object({
    id: z.string().regex(SCREEN_ID_PATTERN),
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_DESIGN_SCREEN_NAME_CHARS)
      .regex(/^\P{Cc}*$/u),
    path: z
      .string()
      .min(1)
      .max(MAX_DESIGN_SCREEN_PATH_CHARS)
      .regex(/^\P{Cc}*$/u),
    viewport: viewportSchema,
  })
  .strict()

const manifestSchema = z
  .object({
    schema: z.literal(DESIGN_SCHEMA),
    title: z
      .string()
      .trim()
      .max(MAX_DESIGN_TITLE_CHARS)
      .regex(/^\P{Cc}*$/u)
      .optional(),
    tokens: z.array(z.string().min(1).max(MAX_PATH_CHARS)).min(1).max(MAX_DESIGN_TOKEN_FILES),
    components: z.string().min(1).max(MAX_PATH_CHARS).optional(),
    screens: z.array(screenSchema).min(1).max(MAX_DESIGN_SCREENS),
    componentTokens: z.record(z.string(), z.array(z.string()).max(MAX_INSPECTED_TOKENS)).optional(),
  })
  .strict()

function normalizeSafeBundleFile(rawPath: string): string | null {
  try {
    const normalized = normalizeBundlePath(rawPath)
    return normalized === rawPath ? normalized : null
  } catch {
    return null
  }
}

function isHtmlPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

function extractScreenFilePart(screenPath: string): string | null {
  const hashIdx = screenPath.indexOf('#')
  const beforeHash = hashIdx >= 0 ? screenPath.slice(0, hashIdx) : screenPath
  const queryIdx = beforeHash.indexOf('?')
  const filePart = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash
  return normalizeSafeBundleFile(filePart)
}

export function parseDesignManifest(
  raw: Uint8Array | string,
  availableFiles: ReadonlySet<string>
): DesignManifest | null {
  let jsonText: string
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) return null
    jsonText = raw
  } else {
    if (raw.byteLength > MAX_MANIFEST_BYTES) return null
    try {
      jsonText = utf8Decoder.decode(raw)
    } catch {
      return null
    }
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonText)
  } catch {
    return null
  }

  const parsed = manifestSchema.safeParse(parsedJson)
  if (!parsed.success) return null
  const data = parsed.data

  const seenTokenFiles = new Set<string>()
  for (const tokenPath of data.tokens) {
    const safe = normalizeSafeBundleFile(tokenPath)
    if (!safe?.toLowerCase().endsWith('.css') || !availableFiles.has(safe) || seenTokenFiles.has(safe)) {
      return null
    }
    seenTokenFiles.add(safe)
  }

  if (data.components !== undefined) {
    const safeComp = normalizeSafeBundleFile(data.components)
    if (!safeComp || !isHtmlPath(safeComp) || !availableFiles.has(safeComp)) return null
  }

  const seenScreenIds = new Set<string>()
  const screens: DesignScreen[] = []
  for (const screen of data.screens) {
    if (seenScreenIds.has(screen.id)) return null
    seenScreenIds.add(screen.id)
    const filePart = extractScreenFilePart(screen.path)
    if (!filePart || !isHtmlPath(filePart) || !availableFiles.has(filePart)) return null
    screens.push({
      id: screen.id,
      name: screen.name,
      path: screen.path,
      viewport: screen.viewport,
    })
  }

  let componentTokens: Record<string, string[]> | undefined
  if (data.componentTokens !== undefined) {
    const entries = Object.entries(data.componentTokens)
    if (entries.length > MAX_INVENTORY_COMPONENTS) return null
    componentTokens = {}
    for (const [comp, tokenList] of entries) {
      if (comp === 'constructor' || comp === 'prototype' || !COMPONENT_NAME_PATTERN.test(comp)) return null
      const deduped: string[] = []
      const seen = new Set<string>()
      for (const name of tokenList) {
        if (!TOKEN_NAME_PATTERN.test(name)) return null
        if (!seen.has(name)) {
          seen.add(name)
          deduped.push(name)
        }
      }
      Object.defineProperty(componentTokens, comp, {
        value: deduped,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
  }

  const manifest: DesignManifest = {
    schema: DESIGN_SCHEMA,
    ...(data.title ? { title: data.title } : {}),
    tokens: data.tokens,
    ...(data.components !== undefined ? { components: data.components } : {}),
    screens,
    ...(componentTokens !== undefined ? { componentTokens } : {}),
  }
  return manifest
}

// --- O(N) CSS custom-property scanner with exact character offsets ---

function skipComment(css: string, pos: number, end: number): number {
  const close = css.indexOf('*/', pos + 2)
  return close >= 0 && close + 2 <= end ? close + 2 : end
}

function skipString(css: string, pos: number, end: number): number {
  const quote = css[pos]!
  let i = pos + 1
  while (i < end) {
    const ch = css[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    i++
  }
  return end
}

function stripCommentsAndCollapse(raw: string): string {
  let out = ''
  let i = 0
  const end = raw.length
  while (i < end) {
    const ch = raw[i]!
    if (ch === '/' && raw[i + 1] === '*') {
      const next = skipComment(raw, i, end)
      const prevChar = out.length > 0 ? out[out.length - 1]! : ''
      const nextChar = next < end ? raw[next]! : ''
      if (prevChar && nextChar && /[a-zA-Z0-9_-]/.test(prevChar) && /[a-zA-Z0-9_(-]/.test(nextChar)) {
        out += ' '
      }
      i = next
      continue
    }
    if (ch === '"' || ch === "'") {
      const next = skipString(raw, i, end)
      out += raw.slice(i, next)
      i = next
      continue
    }
    out += ch
    i++
  }
  return out.replace(/\s+/g, ' ').trim()
}

function splitTopLevelSelectors(prelude: string): string[] {
  const parts: string[] = []
  let depthParen = 0
  let depthBracket = 0
  let start = 0
  let i = 0
  while (i < prelude.length) {
    const ch = prelude[i]!
    if (ch === '"' || ch === "'") {
      i = skipString(prelude, i, prelude.length)
      continue
    }
    if (ch === '(') depthParen++
    else if (ch === ')' && depthParen > 0) depthParen--
    else if (ch === '[') depthBracket++
    else if (ch === ']' && depthBracket > 0) depthBracket--
    else if (ch === ',' && depthParen === 0 && depthBracket === 0) {
      parts.push(prelude.slice(start, i).trim())
      start = i + 1
    }
    i++
  }
  parts.push(prelude.slice(start).trim())
  return parts.filter(Boolean)
}

function normalizeThemePrelude(
  prelude: string,
  mediaTheme: string | null
): { kind: 'root' | 'theme'; theme: string | null } | null {
  const parts = splitTopLevelSelectors(prelude)
  if (parts.length === 0) return null
  const isAllRootOrHtml = parts.every((p) => p === ':root' || p === 'html' || p === ':host') && parts.includes(':root')
  if (mediaTheme !== null) {
    return isAllRootOrHtml ? { kind: 'theme', theme: mediaTheme } : null
  }
  if (isAllRootOrHtml) return { kind: 'root', theme: null }
  if (parts.length !== 1) return null
  const single = parts[0]!.replace(/\s*\[\s*data-theme\s*=\s*/g, '[data-theme=').replace(/\s*\]$/g, ']')
  return isValidThemeSelector(single) ? { kind: 'theme', theme: single } : null
}

function findMatchingBrace(css: string, openBrace: number, end: number): number {
  let depth = 1
  let i = openBrace + 1
  while (i < end) {
    const ch = css[i]!
    if (ch === '/' && css[i + 1] === '*') {
      i = skipComment(css, i, end)
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i, end)
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

interface ValueSegment {
  kind: 'bang' | 'ident' | 'other'
  start: number
  end: number
  text: string
}

function extractValueSpan(
  css: string,
  from: number,
  to: number
): { valueStart: number; valueEnd: number; value: string; hadImportant: boolean } | null {
  const segs: ValueSegment[] = []
  let i = from
  while (i < to) {
    const ch = css[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '/' && css[i + 1] === '*') {
      i = skipComment(css, i, to)
      continue
    }
    if (ch === '"' || ch === "'") {
      const next = skipString(css, i, to)
      segs.push({ kind: 'other', start: i, end: next, text: css.slice(i, next) })
      i = next
      continue
    }
    if (ch === '(') {
      let depth = 1
      let j = i + 1
      while (j < to && depth > 0) {
        const c = css[j]!
        if (c === '/' && css[j + 1] === '*') {
          j = skipComment(css, j, to)
          continue
        }
        if (c === '"' || c === "'") {
          j = skipString(css, j, to)
          continue
        }
        if (c === '(') depth++
        else if (c === ')') depth--
        j++
      }
      segs.push({ kind: 'other', start: i, end: j, text: css.slice(i, j) })
      i = j
      continue
    }
    if (ch === '!') {
      segs.push({ kind: 'bang', start: i, end: i + 1, text: '!' })
      i++
      continue
    }
    if (/[a-zA-Z_-]/.test(ch)) {
      let j = i + 1
      while (j < to && /[a-zA-Z0-9_-]/.test(css[j]!)) j++
      segs.push({ kind: 'ident', start: i, end: j, text: css.slice(i, j) })
      i = j
      continue
    }
    let j = i + 1
    while (
      j < to &&
      !/\s/.test(css[j]!) &&
      css[j] !== '"' &&
      css[j] !== "'" &&
      css[j] !== '(' &&
      css[j] !== '!' &&
      !(css[j] === '/' && css[j + 1] === '*')
    ) {
      j++
    }
    segs.push({ kind: 'other', start: i, end: j, text: css.slice(i, j) })
    i = j
  }

  if (segs.length === 0) return null
  let hadImportant = false
  if (
    segs.length >= 2 &&
    segs[segs.length - 2]!.kind === 'bang' &&
    segs[segs.length - 1]!.kind === 'ident' &&
    /^important$/i.test(segs[segs.length - 1]!.text)
  ) {
    hadImportant = true
    segs.length -= 2
  }
  if (segs.length === 0) return null

  const valueStart = segs[0]!.start
  const valueEnd = segs[segs.length - 1]!.end
  const rawValue = css.slice(valueStart, valueEnd)
  if (!isValidTokenValue(rawValue)) return null
  return { valueStart, valueEnd, value: rawValue, hadImportant }
}

export function parseTokensCssWithSpans(source: string): ParsedTokensCss {
  const rootOrder: string[] = []
  const rootSpans = new Map<string, ParsedTokenSpan>()
  const themeOrder: string[] = []
  const themeSpans = new Map<string, Map<string, ParsedTokenSpan>>()

  function recordDeclaration(span: ParsedTokenSpan): void {
    if (span.theme === null) {
      if (!rootSpans.has(span.name)) {
        if (rootOrder.length >= MAX_DESIGN_TOKENS) return
        rootOrder.push(span.name)
      }
      rootSpans.set(span.name, span)
    } else {
      let byName = themeSpans.get(span.theme)
      if (!byName) {
        byName = new Map()
        themeSpans.set(span.theme, byName)
        themeOrder.push(span.theme)
      }
      byName.set(span.name, span)
    }
  }

  function scanDeclarations(
    bodyStart: number,
    bodyEnd: number,
    theme: string | null,
    blockStart: number,
    blockEnd: number
  ): void {
    let i = bodyStart
    while (i < bodyEnd) {
      while (i < bodyEnd) {
        if (/\s/.test(source[i]!)) i++
        else if (source[i] === '/' && source[i + 1] === '*') i = skipComment(source, i, bodyEnd)
        else break
      }
      if (i >= bodyEnd) break
      const declStart = i
      let colonPos = -1
      let parenDepth = 0
      let braceDepth = 0
      let j = i
      while (j < bodyEnd) {
        const ch = source[j]!
        if (ch === '/' && source[j + 1] === '*') {
          j = skipComment(source, j, bodyEnd)
          continue
        }
        if (ch === '"' || ch === "'") {
          j = skipString(source, j, bodyEnd)
          continue
        }
        if (ch === '(') parenDepth++
        else if (ch === ')' && parenDepth > 0) parenDepth--
        else if (ch === '{') braceDepth++
        else if (ch === '}' && braceDepth > 0) braceDepth--
        else if (parenDepth === 0 && braceDepth === 0) {
          if (ch === ':' && colonPos < 0) colonPos = j
          else if (ch === ';') break
        }
        j++
      }
      const semiPos = j
      const declEnd = semiPos < bodyEnd && source[semiPos] === ';' ? semiPos + 1 : semiPos
      i = declEnd
      if (colonPos < 0) continue

      const propName = stripCommentsAndCollapse(source.slice(declStart, colonPos))
      if (!isValidTokenName(propName)) continue
      const extracted = extractValueSpan(source, colonPos + 1, semiPos)
      if (!extracted) continue

      recordDeclaration({
        name: propName,
        theme,
        value: extracted.value,
        hadImportant: extracted.hadImportant,
        blockStart,
        blockEnd,
        declStart,
        declEnd,
        valueStart: extracted.valueStart,
        valueEnd: extracted.valueEnd,
      })
    }
  }

  function scanRules(
    start: number,
    end: number,
    mediaTheme: string | null,
    enclosingBlock?: { blockStart: number; blockEnd: number }
  ): void {
    let i = start
    while (i < end) {
      while (i < end) {
        if (/\s/.test(source[i]!)) i++
        else if (source[i] === '/' && source[i + 1] === '*') i = skipComment(source, i, end)
        else break
      }
      if (i >= end) break

      const preludeStart = i
      let parenDepth = 0
      let j = i
      while (j < end) {
        const ch = source[j]!
        if (ch === '/' && source[j + 1] === '*') {
          j = skipComment(source, j, end)
          continue
        }
        if (ch === '"' || ch === "'") {
          j = skipString(source, j, end)
          continue
        }
        if (ch === '(') parenDepth++
        else if (ch === ')' && parenDepth > 0) parenDepth--
        else if (parenDepth === 0 && (ch === '{' || ch === ';')) break
        j++
      }

      if (j >= end) break
      if (source[j] === ';') {
        i = j + 1
        continue
      }

      const openBrace = j
      const closeBrace = findMatchingBrace(source, openBrace, end)
      if (closeBrace < 0) break
      const ruleBlockStart = enclosingBlock ? enclosingBlock.blockStart : preludeStart
      const ruleBlockEnd = enclosingBlock ? enclosingBlock.blockEnd : closeBrace + 1
      const prelude = stripCommentsAndCollapse(source.slice(preludeStart, openBrace))

      if (prelude.startsWith('@')) {
        if (/^@layer(?:\s+[a-zA-Z0-9_.-]+(?:\s*,\s*[a-zA-Z0-9_.-]+)*)?$/i.test(prelude)) {
          scanRules(openBrace + 1, closeBrace, mediaTheme, enclosingBlock)
        } else if (mediaTheme === null) {
          const mediaMatch = /^@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i.exec(prelude)
          if (mediaMatch) {
            const normalizedMedia = `@media (prefers-color-scheme: ${mediaMatch[1]!.toLowerCase()})`
            scanRules(openBrace + 1, closeBrace, normalizedMedia, {
              blockStart: preludeStart,
              blockEnd: closeBrace + 1,
            })
          }
        }
      } else {
        const scope = normalizeThemePrelude(prelude, mediaTheme)
        if (scope) {
          scanDeclarations(openBrace + 1, closeBrace, scope.theme, ruleBlockStart, ruleBlockEnd)
        }
      }

      i = closeBrace + 1
    }
  }

  scanRules(0, source.length, null)

  const canonicalNames = new Set(rootOrder)
  const spans = new Map<string, ParsedTokenSpan>()
  const usedThemes: string[] = []
  const usedThemeSet = new Set<string>()

  for (const name of rootOrder) {
    const rootSpan = rootSpans.get(name)!
    spans.set(tokenDraftKey(name, null), rootSpan)
  }

  for (const theme of themeOrder) {
    const map = themeSpans.get(theme)
    if (!map) continue
    for (const [name, span] of map) {
      if (!canonicalNames.has(name)) continue
      spans.set(tokenDraftKey(name, theme), span)
      if (!usedThemeSet.has(theme)) {
        usedThemeSet.add(theme)
        usedThemes.push(theme)
      }
    }
  }

  const tokens: DesignToken[] = rootOrder.map((name) => {
    const rootSpan = rootSpans.get(name)!
    const themes: Record<string, string> = {}
    for (const theme of usedThemes) {
      const themedSpan = spans.get(tokenDraftKey(name, theme))
      if (themedSpan) {
        Object.defineProperty(themes, theme, {
          value: themedSpan.value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
    }
    return {
      name,
      group: groupOfToken(name),
      kind: classifyTokenValue(name, rootSpan.value),
      value: rootSpan.value,
      themes,
    }
  })

  return { tokens, themes: usedThemes, canonicalNames, spans }
}

// --- Exact declaration rewrite into unique, non-overlapping TextEdits ---

interface ReplacementItem {
  valueStart: number
  valueEnd: number
  replacement: string
  declStart: number
  declEnd: number
  blockStart: number
  blockEnd: number
}

interface EditInterval {
  start: number
  end: number
  blockStart: number
  blockEnd: number
  items: ReplacementItem[]
}

function occursOnce(haystack: string, needle: string): boolean {
  if (!needle) return false
  const first = haystack.indexOf(needle)
  if (first < 0) return false
  return haystack.indexOf(needle, first + 1) < 0
}

function mergeOverlappingIntervals(intervals: EditInterval[]): EditInterval[] {
  if (intervals.length <= 1) return intervals
  intervals.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: EditInterval[] = [intervals[0]!]
  for (let i = 1; i < intervals.length; i++) {
    const cur = intervals[i]!
    const prev = merged[merged.length - 1]!
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end)
      prev.blockStart = Math.min(prev.blockStart, cur.blockStart)
      prev.blockEnd = Math.max(prev.blockEnd, cur.blockEnd)
      prev.items.push(...cur.items)
      prev.items.sort((a, b) => a.valueStart - b.valueStart)
    } else {
      merged.push(cur)
    }
  }
  return merged
}

export function buildTokenEdits(
  path: string,
  source: string,
  parsed: ParsedTokensCss,
  rawChanges: readonly TokenChange[]
): { edits: TextEdit[]; appliedChanges: TokenSuggestionChange[] } {
  if (rawChanges.length === 0 || rawChanges.length > MAX_DESIGN_TOKENS) {
    throw new DesignActionError('invalid_tokens', 'Expected between 1 and 200 token changes')
  }

  const seenKeys = new Set<string>()
  const replacements: ReplacementItem[] = []
  const appliedChanges: TokenSuggestionChange[] = []

  for (const item of rawChanges) {
    if (!isValidTokenName(item.name) || !isValidTokenValue(item.value)) {
      throw new DesignActionError('invalid_tokens', `Invalid token change for ${String(item.name)}`)
    }
    const theme = item.theme ?? null
    if (theme !== null && !isValidThemeSelector(theme)) {
      throw new DesignActionError('invalid_tokens', `Invalid theme selector "${theme}"`)
    }
    const key = tokenDraftKey(item.name, theme)
    if (seenKeys.has(key)) {
      throw new DesignActionError('invalid_tokens', `Duplicate token change for ${item.name}`)
    }
    seenKeys.add(key)

    const span = parsed.spans.get(key)
    if (!span || !parsed.canonicalNames.has(item.name)) {
      throw new DesignActionError('unknown_token', `Token ${item.name} is not defined in this scope`)
    }

    const nextValue = item.value.trim()
    if (nextValue === span.value) continue

    replacements.push({
      valueStart: span.valueStart,
      valueEnd: span.valueEnd,
      replacement: nextValue,
      declStart: span.declStart,
      declEnd: span.declEnd,
      blockStart: span.blockStart,
      blockEnd: span.blockEnd,
    })
    appliedChanges.push({
      name: item.name,
      from: span.value,
      to: nextValue,
      ...(theme !== null ? { theme } : {}),
    })
  }

  if (replacements.length === 0) {
    throw new DesignActionError('no_changes', 'Token values match the current version')
  }

  replacements.sort((a, b) => a.valueStart - b.valueStart)
  let intervals: EditInterval[] = replacements.map((item) => ({
    start: item.declStart,
    end: item.declEnd,
    blockStart: item.blockStart,
    blockEnd: item.blockEnd,
    items: [item],
  }))
  intervals = mergeOverlappingIntervals(intervals)

  // Expand any interval whose `oldText` is ambiguous in `source`.
  let changed = true
  while (changed) {
    changed = false
    for (const interval of intervals) {
      if (occursOnce(source, source.slice(interval.start, interval.end))) continue
      changed = true
      if (interval.start > interval.blockStart || interval.end < interval.blockEnd) {
        interval.start = interval.blockStart
        interval.end = interval.blockEnd
      } else {
        while (!occursOnce(source, source.slice(interval.start, interval.end))) {
          const prevNl = interval.start > 0 ? source.lastIndexOf('\n', interval.start - 1) : -1
          const nextNl = interval.end < source.length ? source.indexOf('\n', interval.end) : -1
          const nextStart = Math.max(prevNl, 0)
          const nextEnd = nextNl >= 0 ? nextNl + 1 : source.length
          if (nextStart === interval.start && nextEnd === interval.end) {
            interval.start = 0
            interval.end = source.length
            break
          }
          interval.start = nextStart
          interval.end = nextEnd
        }
      }
    }
    if (changed) intervals = mergeOverlappingIntervals(intervals)
  }

  // Coalesce smallest-gap neighbors if > MAX_EDITS (100), e.g., when editing up to 200 tokens at once.
  while (intervals.length > MAX_EDITS) {
    let bestIdx = 0
    let bestGap = intervals[1]!.start - intervals[0]!.end
    for (let i = 1; i < intervals.length - 1; i++) {
      const gap = intervals[i + 1]!.start - intervals[i]!.end
      if (gap < bestGap) {
        bestGap = gap
        bestIdx = i
      }
    }
    const left = intervals[bestIdx]!
    const right = intervals[bestIdx + 1]!
    left.end = right.end
    left.blockStart = Math.min(left.blockStart, right.blockStart)
    left.blockEnd = Math.max(left.blockEnd, right.blockEnd)
    left.items.push(...right.items)
    left.items.sort((a, b) => a.valueStart - b.valueStart)
    intervals.splice(bestIdx + 1, 1)
  }

  function intervalsToEdits(list: readonly EditInterval[]): TextEdit[] {
    return list.map((interval) => {
      const oldText = source.slice(interval.start, interval.end)
      let newText = ''
      let cursor = interval.start
      for (const item of interval.items) {
        newText += source.slice(cursor, item.valueStart) + item.replacement
        cursor = item.valueEnd
      }
      newText += source.slice(cursor, interval.end)
      return { path, oldText, newText }
    })
  }

  let edits = intervalsToEdits(intervals)
  // Verify sequential uniqueness too, in case an earlier replacement creates a substring matching a later edit.
  let sequentialOk = false
  while (!sequentialOk) {
    sequentialOk = true
    let simulated = source
    for (let idx = 0; idx < edits.length; idx++) {
      const edit = edits[idx]!
      if (!occursOnce(simulated, edit.oldText)) {
        sequentialOk = false
        if (intervals.length > 1) {
          const mergeIdx = idx > 0 ? idx - 1 : 0
          const left = intervals[mergeIdx]!
          const right = intervals[mergeIdx + 1]!
          left.end = right.end
          left.blockStart = Math.min(left.blockStart, right.blockStart)
          left.blockEnd = Math.max(left.blockEnd, right.blockEnd)
          left.items.push(...right.items)
          left.items.sort((a, b) => a.valueStart - b.valueStart)
          intervals.splice(mergeIdx + 1, 1)
        } else {
          intervals[0]!.start = 0
          intervals[0]!.end = source.length
        }
        edits = intervalsToEdits(intervals)
        break
      }
      const pos = simulated.indexOf(edit.oldText)
      simulated = simulated.slice(0, pos) + edit.newText + simulated.slice(pos + edit.oldText.length)
    }
  }

  return { edits, appliedChanges }
}

// --- Cached DesignService over ArtifactStore + BlobStore ---

export interface LoadedEditableDesign {
  design: ViewerDesign
  source: string
  parsed: ParsedTokensCss
}

export interface DesignService {
  getDesign(artifactId: string, version: number): Promise<ViewerDesign | null>
  loadEditable(artifactId: string, version: number): Promise<LoadedEditableDesign | null>
}

export function createDesignService(deps: {
  store: ArtifactStore
  blobs: BlobStore
  maxCacheEntries?: number
}): DesignService {
  const { store, blobs } = deps
  const maxEntries = deps.maxCacheEntries ?? MAX_DESIGN_CACHE_ENTRIES
  const cache = new Map<string, LoadedEditableDesign | null>()

  function getCached(key: string): LoadedEditableDesign | null | undefined {
    if (!cache.has(key)) return undefined
    const val = cache.get(key) ?? null
    cache.delete(key)
    cache.set(key, val)
    return val
  }

  function setCached(key: string, val: LoadedEditableDesign | null): void {
    if (cache.has(key)) cache.delete(key)
    else if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, val)
  }

  async function loadEditable(artifactId: string, version: number): Promise<LoadedEditableDesign | null> {
    const artifact = store.getArtifact(artifactId)
    if (artifact?.kind !== 'page') return null
    if (!store.getVersion(artifactId, version)) return null

    const files = store.listFiles(artifactId, version)
    const byPath = new Map(files.map((f) => [f.path, f]))
    const manifestFile = byPath.get(DESIGN_MANIFEST_PATH)
    if (!manifestFile || manifestFile.bytes > MAX_MANIFEST_BYTES) return null

    const filesHash = createHash('sha256')
      .update(
        files
          .map((f) => `${f.path}:${f.sha256}`)
          .sort()
          .join('\n')
      )
      .digest('hex')
      .slice(0, 24)
    const cacheKey = `${manifestFile.sha256}:${filesHash}`
    const cached = getCached(cacheKey)
    if (cached !== undefined) return cached

    const manifestBytes = await blobs.read(manifestFile.sha256)
    if (!manifestBytes) return null
    const availablePaths = new Set(files.map((f) => f.path))
    const manifest = parseDesignManifest(manifestBytes, availablePaths)
    if (!manifest) {
      setCached(cacheKey, null)
      return null
    }

    const primaryTokenPath = manifest.tokens[0]!
    const tokenFile = byPath.get(primaryTokenPath)
    if (!tokenFile || tokenFile.bytes > MAX_TOKENS_FILE_BYTES) {
      setCached(cacheKey, null)
      return null
    }
    const tokenBytes = await blobs.read(tokenFile.sha256)
    if (!tokenBytes || tokenBytes.byteLength > MAX_TOKENS_FILE_BYTES) {
      setCached(cacheKey, null)
      return null
    }
    let source: string
    try {
      source = cssTextDecoder.decode(tokenBytes)
    } catch {
      setCached(cacheKey, null)
      return null
    }

    const parsed = parseTokensCssWithSpans(source)
    const design: ViewerDesign = {
      title: manifest.title ?? null,
      tokenFile: primaryTokenPath,
      allTokenFiles: [...manifest.tokens],
      componentsPath: manifest.components ?? null,
      screens: manifest.screens,
      componentTokens: manifest.componentTokens ?? {},
      tokens: parsed.tokens,
      themes: parsed.themes,
    }
    const loaded: LoadedEditableDesign = { design, source, parsed }
    setCached(cacheKey, loaded)
    return loaded
  }

  return {
    loadEditable,
    async getDesign(artifactId: string, version: number): Promise<ViewerDesign | null> {
      const loaded = await loadEditable(artifactId, version)
      return loaded ? loaded.design : null
    },
  }
}
