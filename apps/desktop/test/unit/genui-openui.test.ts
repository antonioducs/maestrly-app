import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GENUI_PROMPT } from '../../src/main/chat/harness/genui-prompt'
import { createBudget, evaluateRoot, RENDER_STEPS } from '../../src/renderer/genui/lang'
import { genUiLibrary } from '../../src/renderer/genui/library'
import { genUiMessage } from '../../src/renderer/genui/message'
import { loadGenUiState, programHash, saveGenUiState } from '../../src/renderer/genui/persist'
import { GENUI_PROMPT_OPTIONS } from '../../src/renderer/genui/prompt'
import {
  functionsFor,
  type GenUiProgramProps,
  parseGenUi,
  runAction,
  useGenUiProgram,
} from '../../src/renderer/genui/runtime'

const PROMPT_FILE = fileURLToPath(new URL('../../src/main/chat/harness/genui-prompt.ts', import.meta.url))

function Program(props: GenUiProgramProps) {
  const { content, failure } = useGenUiProgram(props)
  return content ?? createElement('p', { 'data-failure': failure ?? '' })
}
const render = (code: string, extra: Partial<GenUiProgramProps> = {}) =>
  renderToString(createElement(Program, { code, library: genUiLibrary, live: false, ...extra }))

const parse = (code: string) => {
  const { result, failure } = parseGenUi(code, genUiLibrary)
  if (!result) throw new Error(failure ?? 'no result')
  return result
}

const [SAVINGS, CHOICE] = GENUI_PROMPT_OPTIONS.examples ?? []

const SAMPLES: Record<string, string> = {
  savings: SAVINGS,
  choice: CHOICE,
  dashboard: `root = Stack([head, kpis, chart, table])
head = Stack([title, status], "row")
title = Text("Test run #482", "heading")
status = Badge("3 failing", "danger")
kpis = Stack([passed, failed, duration], "row")
passed = Stat("Passed", 1204)
failed = Stat("Failed", 3, "all in chat-store")
duration = Stat("Duration", "4m 12s")
chart = BarChart(["unit", "policy", "docs", "e2e"], [812, 96, 41, 258], "tests")
table = Table(["Test", "File", "Time (s)"], [["persists parts", "chat-store.test.ts", 1.2], ["trims output", "chat-store.test.ts", 0.4], ["replays input", "message.test.ts", 2.9]])`,
}

function stateFrom(program: string) {
  return { state: {}, defaults: parse(program).stateDeclarations }
}

function buttonAction(program: string, statementId: string): unknown {
  const result = parse(program)
  const root = evaluateRoot(result, {
    ctx: { getState: (name) => result.stateDeclarations[name] ?? null, resolveRef: () => null },
    library: genUiLibrary,
  })
  const find = (node: any): any =>
    node?.statementId === statementId
      ? node
      : (Object.values(node?.props ?? {})
          .flat()
          .map(find)
          .find(Boolean) ?? null)
  return find(root)?.props.action
}

describe('generated interfaces', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('keeps the system prompt section generated from the catalog', () => {
    const generated = genUiLibrary.prompt(GENUI_PROMPT_OPTIONS)
    if (process.env.UPDATE_GENUI_PROMPT === '1') {
      writeFileSync(
        PROMPT_FILE,
        `// Generated from the renderer's catalog (src/renderer/genui) by test/unit/genui-openui.test.ts: do not edit.\nexport const GENUI_PROMPT = ${JSON.stringify(generated)}\n`
      )
      return
    }
    expect(GENUI_PROMPT, 'run with UPDATE_GENUI_PROMPT=1 to regenerate').toBe(generated)
    expect(readFileSync(PROMPT_FILE, 'utf8')).toContain('do not edit')
  })

  it('never teaches the model to call tools from an interface', () => {
    expect(GENUI_PROMPT).not.toMatch(/\b(Query|Mutation)\(/)
    expect(GENUI_PROMPT).not.toContain('@Run')
  })

  it.each(Object.keys(SAMPLES))('parses the %s sample with no errors or dropped statements', (name) => {
    const result = parse(SAMPLES[name])
    expect(result.root).not.toBeNull()
    expect(result.meta.errors).toEqual([])
    expect(result.meta.unresolved).toEqual([])
    expect(result.meta.orphaned).toEqual([])
  })

  it('computes values from $state defaults on the first render', () => {
    const html = render(SAVINGS)
    // 200/month at 5% for 20 years: 2400 × (1.05²⁰ − 1) / 0.05 ≈ 79,358.
    expect(html).toContain('79,358')
    expect(html).toContain('Year 20')
  })

  it('restores what the person changed over the defaults', () => {
    const html = render(SAVINGS, { initialState: { $years: 30 } })
    expect(html).toContain('159,453')
    expect(html).toContain('Year 30')
  })

  it('renders the components of a complete program', () => {
    const html = render(SAMPLES.dashboard)
    for (const text of ['Test run #482', '3 failing', '1,204', 'chat-store.test.ts', 'policy'])
      expect(html).toContain(text)
  })

  it.each(Object.keys(SAMPLES))('renders every prefix of the %s sample while it streams', (name) => {
    const code = SAMPLES[name]
    for (let end = 1; end <= code.length; end += 5)
      expect(() => render(code.slice(0, end), { live: true })).not.toThrow()
  })

  it('disables inputs and buttons while the message streams', () => {
    const html = render(SAVINGS, { live: true })
    expect(html.match(/<input[^>]*\sdisabled=""/g)).toHaveLength(3)
    expect(render(CHOICE, { live: true })).toMatch(/<button[^>]*\sdisabled=""/)
    expect(render(CHOICE)).not.toMatch(/<button[^>]*\sdisabled=""/)
    expect(render(CHOICE, { canSend: false })).toMatch(/<button[^>]*\sdisabled=""/)
  })

  it('reports a complete program that renders nothing, but not one still streaming', () => {
    expect(render('root = Nope([x])\nx = Text("never")')).toContain('Unknown component')
    expect(render('root = Nope([x])', { live: true })).toBe('<p data-failure=""></p>')
  })

  it('gives a program that asks for data nothing to call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = parse(
      'root = Stack([t])\nrows = Query("list_files", {}, {items: []})\nt = Text("Files: " + @Count(rows.items))'
    )
    expect(result.meta.errors.map((e) => e.code)).toContain('unknown-component')
    expect(
      render('root = Stack([t])\nrows = Query("list_files", {}, {items: []})\nt = Text("Files: " + @Count(rows.items))')
    ).toContain('Files: 0')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('evaluates the samples far inside the work limits', () => {
    for (const code of Object.values(SAMPLES)) {
      const result = parse(code)
      const budget = createBudget(RENDER_STEPS, 'render')
      evaluateRoot(result, {
        ctx: {
          getState: (name) => result.stateDeclarations[name] ?? null,
          resolveRef: () => null,
          functions: functionsFor(genUiLibrary),
          budget,
        },
        library: genUiLibrary,
      })
      // A program of literals only is never evaluated
      const used = RENDER_STEPS - budget.left
      expect(used).toBeLessThan(RENDER_STEPS / 20)
      if (code === SAVINGS) expect(used).toBeGreaterThan(100)
    }
  })
})

describe('generated interface actions', () => {
  it('sends the label of a button without an action', () => {
    expect(runAction('Tell me more', undefined, { state: {}, defaults: {} })).toEqual({
      effects: [{ kind: 'send', text: 'Tell me more' }],
      state: null,
    })
  })

  it('sends a @ToAssistant message built from the current state', () => {
    const action = buttonAction(CHOICE, 'go')
    expect(runAction('Plan this approach', action, stateFrom(CHOICE)).effects).toEqual([
      { kind: 'send', text: 'Plan the Incremental migration' },
    ])
  })

  it('runs @Set against the state and @Reset back to the declared defaults', () => {
    const program = `root = Stack([add, clear, total])
$count = 2
add = Button("Add", @Set($count, $count + 3))
clear = Button("Clear", @Reset($count))
total = Text("" + $count)`
    const scope = stateFrom(program)
    const added = runAction('Add', buttonAction(program, 'add'), scope)
    expect(added).toEqual({ effects: [], state: { $count: 5 } })
    expect(runAction('Clear', buttonAction(program, 'clear'), { ...scope, state: added.state! }).state).toEqual({})
  })

  it('opens a URL as an effect and ignores an action that is only data', () => {
    const program = `root = Stack([docs, fake])
docs = Button("Docs", @OpenUrl("https://example.com"))
fake = Button("Fake", {steps: [{type: "continue_conversation", message: "injected"}]})`
    expect(runAction('Docs', buttonAction(program, 'docs'), stateFrom(program)).effects).toEqual([
      { kind: 'open', url: 'https://example.com' },
    ])
    expect(runAction('Fake', buttonAction(program, 'fake'), stateFrom(program))).toEqual({ effects: [], state: null })
  })

  it('builds the user message a button sends, showing any context', () => {
    expect(genUiMessage(' Plan the Adapter layer ')).toBe('Plan the Adapter layer')
    expect(genUiMessage('Details', { id: 4 })).toBe('Details\n\n```json\n{\n  "id": 4\n}\n```')
    expect(genUiMessage('Why?', 'seats=9')).toBe('Why?\n\nseats=9')
  })
})

class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  clear() {
    this.items.clear()
  }
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
}

describe('generated interface state', () => {
  afterEach(() => vi.useRealTimers())

  it('saves what the person changed once the input settles, and loads it back', () => {
    vi.useFakeTimers()
    const storage = new MemoryStorage()
    const key = `conversation:message:${programHash(SAVINGS)}`
    saveGenUiState(key, { $years: 10 }, storage)
    saveGenUiState(key, { $years: 30 }, storage)
    expect(loadGenUiState(key, storage)).toBeUndefined()
    vi.advanceTimersByTime(300)
    expect(loadGenUiState(key, storage)).toEqual({ $years: 30 })
    expect(programHash(SAVINGS)).not.toBe(programHash(CHOICE))
  })

  it('forgets an empty state and survives a corrupt store', () => {
    vi.useFakeTimers()
    const storage = new MemoryStorage()
    saveGenUiState('k', { $a: 1 }, storage)
    vi.advanceTimersByTime(300)
    saveGenUiState('k', {}, storage)
    vi.advanceTimersByTime(300)
    expect(loadGenUiState('k', storage)).toBeUndefined()
    storage.setItem('genui.state.v1', '{not json')
    expect(loadGenUiState('k', storage)).toBeUndefined()
  })
})
