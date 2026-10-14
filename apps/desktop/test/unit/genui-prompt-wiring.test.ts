import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  maestrlyAstraHostInstructions,
  maestrlyDeveloperInstructions,
} from '../../src/main/chat/codex-subscription/runner'
import { harnessFor, resolveChatHarness } from '../../src/main/chat/harness/execution'
import { GENUI_PROMPT } from '../../src/main/chat/harness/genui-prompt'
import { buildMaestrlyBasePrompt } from '../../src/main/chat/harness/host-contracts'
import { buildHarnessPrompt } from '../../src/main/chat/harness/prompt-builder'
import { isFenceClosed, isPendingFence, isWidgetFence } from '../../src/renderer/genui/fences'
import { GENUI_PREVIEW_TOOL } from '../../src/shared/genui-widget'

const OFFICIAL = 'https://api.openai.com/v1'
const common = { cwd: '/repo', mode: 'agent' as const, appToolsEnabled: true, hasNotesTab: true }
const main = (path: string) => readFileSync(new URL(`../../src/main/chat/${path}`, import.meta.url), 'utf8')

describe('generated interfaces in the system prompt', () => {
  const generic = harnessFor('anthropic', 'generic-model')
  const sol = resolveChatHarness('openai-responses', 'gpt-5.6-sol', OFFICIAL).harness
  const astra = resolveChatHarness('openai-responses', 'gpt-6-astra', OFFICIAL).harness
  const prompts = (generatedInterfaces?: boolean) => {
    const option = generatedInterfaces === undefined ? {} : { generatedInterfaces }
    return {
      project: buildMaestrlyBasePrompt({ ...common, harness: generic, ...option }),
      standalone: buildMaestrlyBasePrompt({ ...common, harness: generic, scope: 'standalone', ...option }),
      codex: maestrlyDeveloperInstructions('agent', [], [], option),
      codexAstra: maestrlyAstraHostInstructions('agent', [], [], { conversationId: 'c', ...option }),
      codexPort: buildHarnessPrompt({ ...common, harness: sol, ...option }).stablePrefix,
      astra: buildHarnessPrompt({ ...common, harness: astra, ...option }).stablePrefix,
    }
  }

  it('reaches every layout a conversation uses while the setting is on', () => {
    expect(sol.prompts.layout).toBe('openai-codex-port')
    expect(astra.prompts.layout).toBe('openai-astra')
    for (const on of [prompts(), prompts(true)])
      for (const [name, prompt] of Object.entries(on)) expect(prompt, name).toContain(GENUI_PROMPT)
  })

  it('stays out when the person turned interfaces off, and for delegated subagents', () => {
    for (const [name, prompt] of Object.entries(prompts(false))) {
      expect(prompt, name).not.toContain('# Interactive answers')
      expect(prompt, name).not.toContain('inline-html')
    }
    expect(main('subagent-runner.ts')).toContain('generatedInterfaces: false,')
  })

  it('reads the setting wherever a runtime builds its prompt', () => {
    const sites: Record<string, number> = {
      'runner.ts': 2,
      'claude-agent-sdk/runner.ts': 1,
      'codex-subscription/runner.ts': 3,
      'github-copilot/runner.ts': 2,
      'cursor-subscription/session.ts': 1,
      'antigravity-subscription/session.ts': 1,
    }
    for (const [path, count] of Object.entries(sites))
      expect(main(path).split('generatedInterfaces: generatedInterfacesEnabled(),').length - 1, path).toBe(count)
  })

  it('teaches inline HTML only, and showing a preview by its id', () => {
    expect(GENUI_PROMPT).not.toContain('openui')
    expect(GENUI_PROMPT).toContain(`When the ${GENUI_PREVIEW_TOOL} tool is available`)
    expect(GENUI_PROMPT).toContain('```inline-html preview=<id>\n```')
  })
})

describe('generated interface fences', () => {
  it('recognizes the interface fence and the ones that may still become it', () => {
    expect(isWidgetFence('language-inline-html')).toBe(true)
    expect(isWidgetFence('language-html')).toBe(false)
    expect(isWidgetFence('language-openui-lang')).toBe(false)
    expect(isPendingFence('language-inl', '<div')).toBe(true)
    expect(isPendingFence('language-inline-', '<div>')).toBe(true)
    expect(isPendingFence('', '')).toBe(true)
    expect(isPendingFence('language-ts', 'const a = 1')).toBe(false)
    expect(isPendingFence('language-html', '<div>')).toBe(false)
    expect(isPendingFence('language-inline-html', '<div>')).toBe(false)
  })

  it('tells a closed block from one still streaming', () => {
    expect(isFenceClosed('```inline-html\n<p>a</p>\n```')).toBe(true)
    expect(isFenceClosed('```inline-html\r\n<p>a</p>\r\n```\r\n')).toBe(true)
    expect(isFenceClosed('  ````inline-html\n  <p>a</p>\n  ````')).toBe(true)
    expect(isFenceClosed('~~~inline-html\n<p>a</p>\n~~~')).toBe(true)
    expect(isFenceClosed('```inline-html\n<p>a</p>\n``')).toBe(false)
    expect(isFenceClosed('```inline-html\n<p>a</p>')).toBe(false)
    expect(isFenceClosed('````inline-html\n<p>a</p>\n```')).toBe(false)
    expect(isFenceClosed('```inline-html\n<p>a</p>\n~~~')).toBe(false)
    expect(isFenceClosed('```')).toBe(false)
  })
})

describe('generated interfaces in every transcript', () => {
  const source = (path: string) => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')

  it('gives chat messages their stream, sending and the previews they rendered', () => {
    const list = source('components/chat/ChatMessageList.tsx')
    expect(list).toContain('<GenUiContext.Provider value={genUiHost}>')
    expect(list).toContain('const previews = useMemo(() => genUiPreviewsOf(message.parts), [message.parts])')
    expect(list).toContain('onUiSend={readOnly ? undefined : onUiSend}')
  })

  it("keeps the answer's prose styles out of interfaces", () => {
    const styles = readFileSync(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8')
    expect(styles).toContain(
      '.dark-glass-prose\n  .genui-widget\n  :is(p, h1, h2, h3, h4, ul, ol, li, a, strong, blockquote, hr, code, pre, table, th, td):not(#genui-prose-reset) {\n  all: revert-layer;'
    )
    expect(source('genui/HtmlWidgetBlock.tsx')).toContain('className="genui-widget')
  })

  it('gives bot answers their stream and sends through the bot', () => {
    const bot = source('components/fleet/BotConversation.tsx')
    expect(bot).toContain('<GenUiContext.Provider value={transcriptHost}>')
    expect(bot).toContain('streaming={!!item.streaming}')
    expect(bot).toMatch(/\.fleetSendMessage\(bot\.id, text\)/)
    expect(bot).toContain('const interfaceSend = locked ? undefined : sendFromInterface')
  })
})
