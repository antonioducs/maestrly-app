/**
 * `edit` tool — ported from opencode tool/edit.ts's GOLD-STANDARD ALGORITHM (without Effect).
 * Exact matching with controlled fuzzy fallback (line-trimmed, whitespace-normalized, block-anchor),
 * line-ending normalization, BOM preservation, occurrence counts, clobber guard, and preview.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  countOccurrences,
  defineTool,
  detectEnding,
  hasUtf8Bom,
  previewDiff,
  resolveInside,
  stripBom,
  toEnding,
  withFileLock,
  type ToolContext,
} from './util'

const params = z.object({
  path: z.string().describe('Path of the file to edit.'),
  oldString: z.string().describe('EXACT text to replace (including indentation).'),
  newString: z.string().describe('Replacement text (must differ from oldString).'),
  replaceAll: z.boolean().optional().describe('Replace all exact occurrences (default false).'),
})

interface EditResult {
  resource: string
  replacements: number
  oldString: string
  newString: string
  /** Present when replacement was NOT an exact match (model/user transparency). */
  matchKind?: Exclude<MatchKind, 'exact'>
}

export type MatchKind = 'exact' | 'line-trimmed' | 'whitespace-normalized' | 'block-anchor'
export interface ReplacementMatch {
  start: number
  end: number
  matched: string
  kind: MatchKind
}

interface LineSpan {
  start: number
  end: number
  bodyEnd: number
  text: string
  body: string
}

function splitSnippetLines(s: string): string[] {
  const lines = s.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function lineSpans(text: string): LineSpan[] {
  const out: LineSpan[] = []
  const re = /.*(?:\r\n|\n|$)/g
  for (;;) {
    const m = re.exec(text)
    if (!m || m[0] === '') break
    const line = m[0]
    const nl = line.endsWith('\r\n') ? 2 : line.endsWith('\n') ? 1 : 0
    out.push({ start: m.index, end: m.index + line.length, bodyEnd: m.index + line.length - nl, text: line, body: line.slice(0, line.length - nl) })
  }
  return out
}

function indentOf(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? ''
}

function firstNonEmpty(lines: string[]): { index: number; line: string } | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) return { index: i, line: lines[i] }
  }
  return null
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function rangesOverlap(a: ReplacementMatch, b: ReplacementMatch): boolean {
  return a.start < b.end && b.start < a.end
}

function dedupeMatches(matches: ReplacementMatch[]): ReplacementMatch[] {
  const out: ReplacementMatch[] = []
  for (const m of matches.sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (out.some((x) => x.start === m.start && x.end === m.end)) continue
    if (out.some((x) => rangesOverlap(x, m))) continue
    out.push(m)
  }
  return out
}

function exactMatches(text: string, needle: string): ReplacementMatch[] {
  const out: ReplacementMatch[] = []
  let i = 0
  while ((i = text.indexOf(needle, i)) !== -1) {
    out.push({ start: i, end: i + needle.length, matched: needle, kind: 'exact' })
    i += needle.length
  }
  return out
}

function lineWindowMatches(text: string, oldString: string, kind: 'line-trimmed' | 'whitespace-normalized'): ReplacementMatch[] {
  const spans = lineSpans(text)
  const oldLines = splitSnippetLines(oldString)
  if (oldLines.length === 0 || oldLines.length > spans.length) return []
  const oldKey = kind === 'line-trimmed' ? oldLines.map((l) => l.trim()).join('\n') : normalizeWhitespace(oldLines.join('\n'))
  if (!oldKey) return []
  const includeTrailingNewline = /(?:\r\n|\n)$/.test(oldString)
  const out: ReplacementMatch[] = []
  for (let i = 0; i <= spans.length - oldLines.length; i++) {
    const win = spans.slice(i, i + oldLines.length)
    const key = kind === 'line-trimmed' ? win.map((l) => l.body.trim()).join('\n') : normalizeWhitespace(win.map((l) => l.body).join('\n'))
    if (key !== oldKey) continue
    const start = win[0].start
    const last = win[win.length - 1]
    const end = includeTrailingNewline ? last.end : last.bodyEnd
    out.push({ start, end, matched: text.slice(start, end), kind })
  }
  return dedupeMatches(out)
}

function blockAnchorMatches(text: string, oldString: string): ReplacementMatch[] {
  const spans = lineSpans(text)
  const oldLines = splitSnippetLines(oldString)
  // Opencode parity: block-anchor requires ≥3 lines (anchors + interior). With two lines, snippet anchors are
  // adjacent but could match ANY pair in the file — replacing an arbitrary span.
  if (oldLines.length < 3) return []
  const first = firstNonEmpty(oldLines)
  if (!first) return []
  let last = first
  for (let i = oldLines.length - 1; i >= 0; i--) {
    if (oldLines[i].trim()) {
      last = { index: i, line: oldLines[i] }
      break
    }
  }
  if (last.index - first.index < 2) return []
  const firstKey = first.line.trim()
  const lastKey = last.line.trim()
  const includeTrailingNewline = /(?:\r\n|\n)$/.test(oldString)
  const out: ReplacementMatch[] = []
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].body.trim() !== firstKey) continue
    for (let j = i + 2; j < spans.length; j++) {
      if (spans[j].body.trim() !== lastKey) continue
      const start = spans[i].start
      const end = includeTrailingNewline ? spans[j].end : spans[j].bodyEnd
      out.push({ start, end, matched: text.slice(start, end), kind: 'block-anchor' })
      break
    }
  }
  return dedupeMatches(out)
}

function reindentReplacement(newString: string, oldString: string, matched: string): string {
  const oldLines = splitSnippetLines(oldString)
  const newLines = splitSnippetLines(newString)
  const matchedLines = splitSnippetLines(matched)
  const converted = newLines.map((line, i) => {
    if (!line.trim()) return line
    const oldRef = oldLines[Math.min(i, oldLines.length - 1)] ?? ''
    const matchedRef = matchedLines[Math.min(i, matchedLines.length - 1)] ?? ''
    const oldIndent = indentOf(oldRef)
    const matchedIndent = indentOf(matchedRef)
    if (oldIndent === matchedIndent) return line
    if (oldIndent && line.startsWith(oldIndent)) return matchedIndent + line.slice(oldIndent.length)
    if (!oldIndent && matchedIndent && !line.startsWith(matchedIndent)) return matchedIndent + line
    return line
  })
  const ending = detectEnding(newString)
  return converted.join(ending) + (/(?:\r\n|\n)$/.test(newString) ? ending : '')
}

export function findReplacementMatches(text: string, oldString: string): ReplacementMatch[] {
  for (const matches of [
    exactMatches(text, oldString),
    lineWindowMatches(text, oldString, 'line-trimmed'),
    lineWindowMatches(text, oldString, 'whitespace-normalized'),
    blockAnchorMatches(text, oldString),
  ]) {
    if (matches.length) return matches
  }
  return []
}

interface AppliedReplacement {
  next: string
  replacements: number
  kind: MatchKind
  /** Text ACTUALLY replaced / inserted at the first match — preview reflects the applied edit. */
  matched: string
  replacement: string
}

function applyReplacement(text: string, oldString: string, newString: string, replaceAll = false): AppliedReplacement {
  const matches = findReplacementMatches(text, oldString)
  if (matches.length === 0) {
    throw new Error('oldString not found. It must match the target block uniquely; exact, line-trimmed, whitespace-normalized and block-anchor matching all failed.')
  }
  // block-anchor matches blocks with DIFFERENT CONTENT (only anchors match) — replaceAll across several is
  // almost certainly destructive; require more context for disambiguation.
  if (matches.length > 1 && (!replaceAll || matches[0].kind === 'block-anchor')) {
    const exactCount = countOccurrences(text, oldString)
    const suffix = exactCount > 1 ? ' exact occurrences' : ` ${matches[0].kind} occurrences`
    throw new Error(`Found ${matches.length}${suffix}. Add more context${matches[0].kind === 'block-anchor' ? '' : ' or use replaceAll:true'}.`)
  }
  const chosen = replaceAll ? matches : matches.slice(0, 1)
  let next = text
  let firstReplacement = newString
  for (const m of [...chosen].sort((a, b) => b.start - a.start)) {
    const replacement = m.kind === 'exact' ? newString : reindentReplacement(newString, oldString, m.matched)
    if (m === chosen[0]) firstReplacement = replacement
    next = next.slice(0, m.start) + replacement + next.slice(m.end)
  }
  return { next, replacements: chosen.length, kind: chosen[0].kind, matched: chosen[0].matched, replacement: firstReplacement }
}

async function run(args: z.infer<typeof params>, ctx: ToolContext): Promise<EditResult> {
  if (args.oldString === args.newString) throw new Error('No changes to apply (oldString == newString).')
  if (args.oldString === '') throw new Error('oldString cannot be empty. Use the write tool to create/overwrite.')

  const { abs, external } = resolveInside(ctx.cwd, args.path)
  if (external) await ctx.ask('external_directory', [abs], [abs])
  await ctx.ask('edit', [abs], ['*'])

  return withFileLock(abs, async () => {
    const original = await fs.readFile(abs).catch(() => {
      throw new Error(`File not found: ${path.relative(ctx.cwd, abs)}`)
    })
    const hadBom = hasUtf8Bom(original)
    const text = stripBom(original.toString('utf8'))
    const ending = detectEnding(text)
    const oldConv = toEnding(args.oldString, ending)
    const newConv = toEnding(args.newString, ending)

    const { next, replacements, kind, matched, replacement } = applyReplacement(text, oldConv, newConv, args.replaceAll === true)
    const finalText = hadBom ? '\ufeff' + next : next

    // Clobber guard: did the file change between read and write?
    const current = await fs.readFile(abs)
    if (!current.equals(original))
      throw new Error('The file changed after approval. Read it again before editing.')
    await fs.writeFile(abs, finalText, 'utf8')

    return {
      resource: path.relative(ctx.cwd, abs) || path.basename(abs),
      replacements,
      // Fuzzy replacement differs from the requested text — preview shows the ACTUAL applied edit.
      oldString: kind === 'exact' ? args.oldString : matched,
      newString: kind === 'exact' ? args.newString : replacement,
      ...(kind !== 'exact' ? { matchKind: kind } : {}),
    }
  })
}

export const editTool = defineTool({
  name: 'edit',
  description: 'Edits a file by replacing a snippet. Exact match is preferred; safe fuzzy matching tolerates indentation/whitespace drift.',
  parameters: params,
  execute: run,
  toModelText: (_args, r) =>
    `Edited file: ${r.resource}\nReplacements: ${r.replacements}${r.matchKind ? ` (fuzzy match: ${r.matchKind})` : ''}\n${previewDiff(r.oldString, r.newString)}`,
})
