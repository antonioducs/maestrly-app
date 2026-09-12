/*
 * Copyright 2025 OpenAI
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * TypeScript adaptation, modified for the headerless V4A diffs emitted by the
 * OpenAI Responses apply_patch tool. The parser/application semantics come from
 * OpenAI Codex's apply-patch crate at commit 5bed6447998c754d154dbd796517310b8f04d4ce:
 * codex-rs/apply-patch/src/parser.rs (Apache-2.0).
 */

export type V4ADiffMode = 'default' | 'create'

interface Chunk {
  origIndex: number
  deleted: string[]
  inserted: string[]
}

interface ParserState {
  lines: string[]
  index: number
  fuzz: number
}

const END_PATCH = '*** End Patch'
const END_FILE = '*** End of File'
const SECTION_MARKERS = [END_PATCH, '*** Update File:', '*** Delete File:', '*** Add File:', END_FILE]
const SECTION_TERMINATORS = [END_PATCH, '*** Update File:', '*** Delete File:', '*** Add File:']

/** Applies one headerless V4A operation to LF-normalized text. */
export function applyV4ADiff(input: string, diff: string, mode: V4ADiffMode = 'default'): string {
  const lines = normalizeDiffLines(diff)
  if (mode === 'create') return parseCreateDiff(lines)
  return applyChunks(input, parseUpdateDiff(lines, input).chunks)
}

function normalizeDiffLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line, index, lines) => !(index === lines.length - 1 && line === ''))
}

function isDone(state: ParserState, prefixes: string[]): boolean {
  const line = state.lines[state.index]
  return line == null || prefixes.some((prefix) => line.startsWith(prefix))
}

function readPrefix(state: ParserState, prefix: string): string {
  const line = state.lines[state.index]
  if (line == null || !line.startsWith(prefix)) return ''
  state.index += 1
  return line.slice(prefix.length)
}

function parseCreateDiff(lines: string[]): string {
  const state: ParserState = { lines: [...lines, END_PATCH], index: 0, fuzz: 0 }
  const output: string[] = []
  while (!isDone(state, SECTION_TERMINATORS)) {
    const line = state.lines[state.index++]
    if (!line.startsWith('+')) throw new Error(`Invalid Add File Line: ${line}`)
    output.push(line.slice(1))
  }
  return output.join('\n')
}

function parseUpdateDiff(lines: string[], input: string): { chunks: Chunk[]; fuzz: number } {
  const state: ParserState = { lines: [...lines, END_PATCH], index: 0, fuzz: 0 }
  const inputLines = input.split('\n')
  const chunks: Chunk[] = []
  let cursor = 0

  while (!isDone(state, SECTION_MARKERS)) {
    const anchor = readPrefix(state, '@@ ')
    const bareAnchor = !anchor && state.lines[state.index] === '@@'
    if (bareAnchor) state.index += 1
    if (!(anchor || bareAnchor || cursor === 0)) {
      throw new Error(`Invalid Line:\n${state.lines[state.index]}`)
    }

    if (anchor.trim()) cursor = advanceToAnchor(anchor, inputLines, cursor, state)
    const section = readSection(state.lines, state.index)
    const match = findContext(inputLines, section.context, cursor, section.eof)
    if (match.index === -1) {
      const label = section.eof ? 'EOF Context' : 'Context'
      throw new Error(`Invalid ${label} ${cursor}:\n${section.context.join('\n')}`)
    }

    state.fuzz += match.fuzz
    for (const chunk of section.chunks) {
      chunks.push({ ...chunk, origIndex: chunk.origIndex + match.index })
    }
    cursor = match.index + section.context.length
    state.index = section.endIndex
  }

  return { chunks, fuzz: state.fuzz }
}

function advanceToAnchor(anchor: string, input: string[], cursor: number, state: ParserState): number {
  if (!input.slice(0, cursor).some((line) => line === anchor)) {
    for (let index = cursor; index < input.length; index++) {
      if (input[index] === anchor) return index + 1
    }
  }

  if (!input.slice(0, cursor).some((line) => line.trim() === anchor.trim())) {
    for (let index = cursor; index < input.length; index++) {
      if (input[index].trim() === anchor.trim()) {
        state.fuzz += 1
        return index + 1
      }
    }
  }
  return cursor
}

function readSection(
  lines: string[],
  startIndex: number
): { context: string[]; chunks: Chunk[]; endIndex: number; eof: boolean } {
  const context: string[] = []
  let deleted: string[] = []
  let inserted: string[] = []
  const chunks: Chunk[] = []
  let mode: 'keep' | 'add' | 'delete' = 'keep'
  let index = startIndex

  const flush = (): void => {
    if (inserted.length === 0 && deleted.length === 0) return
    chunks.push({ origIndex: context.length - deleted.length, deleted, inserted })
    deleted = []
    inserted = []
  }

  while (index < lines.length) {
    const raw = lines[index]
    if (
      raw.startsWith('@@') ||
      raw.startsWith(END_PATCH) ||
      raw.startsWith('*** Update File:') ||
      raw.startsWith('*** Delete File:') ||
      raw.startsWith('*** Add File:') ||
      raw.startsWith(END_FILE) ||
      raw === '***'
    ) {
      break
    }
    if (raw.startsWith('***')) throw new Error(`Invalid Line: ${raw}`)
    index += 1

    const previousMode = mode
    const normalized = raw === '' ? ' ' : raw
    const marker = normalized[0]
    if (marker === '+') mode = 'add'
    else if (marker === '-') mode = 'delete'
    else if (marker === ' ') mode = 'keep'
    else throw new Error(`Invalid Line: ${normalized}`)

    const line = normalized.slice(1)
    if (mode === 'keep' && previousMode !== 'keep') flush()
    if (mode === 'delete') {
      deleted.push(line)
      context.push(line)
    } else if (mode === 'add') {
      inserted.push(line)
    } else {
      context.push(line)
    }
  }

  flush()
  if (lines[index] === END_FILE) return { context, chunks, endIndex: index + 1, eof: true }
  if (index === startIndex) throw new Error(`Nothing in this section - index=${index} ${lines[index]}`)
  return { context, chunks, endIndex: index, eof: false }
}

function findContext(input: string[], context: string[], start: number, eof: boolean): { index: number; fuzz: number } {
  if (!eof) return findContextCore(input, context, start)
  const atEnd = findContextCore(input, context, Math.max(0, input.length - context.length))
  if (atEnd.index !== -1) return atEnd
  const fallback = findContextCore(input, context, start)
  return { index: fallback.index, fuzz: fallback.fuzz + 10_000 }
}

function findContextCore(input: string[], context: string[], start: number): { index: number; fuzz: number } {
  if (context.length === 0) return { index: start, fuzz: 0 }
  for (let index = start; index < input.length; index++) {
    if (equalsSlice(input, context, index, (line) => line)) return { index, fuzz: 0 }
  }
  for (let index = start; index < input.length; index++) {
    if (equalsSlice(input, context, index, (line) => line.trimEnd())) return { index, fuzz: 1 }
  }
  for (let index = start; index < input.length; index++) {
    if (equalsSlice(input, context, index, (line) => line.trim())) return { index, fuzz: 100 }
  }
  return { index: -1, fuzz: 0 }
}

function equalsSlice(source: string[], target: string[], start: number, map: (value: string) => string): boolean {
  if (start + target.length > source.length) return false
  return target.every((line, offset) => map(source[start + offset]) === map(line))
}

function applyChunks(input: string, chunks: Chunk[]): string {
  const original = input.split('\n')
  const output: string[] = []
  let cursor = 0

  for (const chunk of chunks) {
    if (chunk.origIndex > original.length) {
      throw new Error(`applyV4ADiff: chunk index ${chunk.origIndex} exceeds input length ${original.length}`)
    }
    if (cursor > chunk.origIndex) {
      throw new Error(`applyV4ADiff: overlapping chunk at ${chunk.origIndex} (cursor ${cursor})`)
    }
    output.push(...original.slice(cursor, chunk.origIndex), ...chunk.inserted)
    cursor = chunk.origIndex + chunk.deleted.length
  }

  output.push(...original.slice(cursor))
  return output.join('\n')
}
