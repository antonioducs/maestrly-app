import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { maestrlyDeveloperInstructions } from '../../src/main/chat/codex-subscription/runner'
import { harnessFor, resolveChatHarness } from '../../src/main/chat/harness/execution'
import { GENUI_PROMPT } from '../../src/main/chat/harness/genui-prompt'
import { buildMaestrlyBasePrompt } from '../../src/main/chat/harness/host-contracts'
import { buildHarnessPrompt } from '../../src/main/chat/harness/prompt-builder'
import { isFenceClosed, isGenUiFence, isPendingFence, isWidgetFence } from '../../src/renderer/genui/fences'

const OFFICIAL = 'https://api.openai.com/v1'
const common = { cwd: '/repo', mode: 'agent' as const, appToolsEnabled: true, hasNotesTab: true }

describe('generated interfaces in the system prompt', () => {
  const generic = harnessFor('anthropic', 'generic-model')
  const sol = resolveChatHarness('openai-responses', 'gpt-5.6-sol', OFFICIAL).harness
  const astra = resolveChatHarness('openai-responses', 'gpt-6-astra', OFFICIAL).harness

  it('reaches every layout a conversation uses, with no setting to turn on', () => {
    expect(sol.prompts.layout).toBe('openai-codex-port')
    expect(astra.prompts.layout).toBe('openai-astra')
    const prompts = {
      project: buildMaestrlyBasePrompt({ ...common, harness: generic }),
      standalone: buildMaestrlyBasePrompt({ ...common, harness: generic, scope: 'standalone' }),
      codex: maestrlyDeveloperInstructions('agent', [], []),
      codexPort: buildHarnessPrompt({ ...common, harness: sol }).stablePrefix,
      astra: buildHarnessPrompt({ ...common, harness: astra }).stablePrefix,
    }
    for (const [name, prompt] of Object.entries(prompts)) expect(prompt, name).toContain(GENUI_PROMPT)
  })

  it('stays out of delegated subagents, whose output goes to a model', () => {
    for (const harness of [generic, sol, astra]) {
      const prompt = buildHarnessPrompt({ ...common, harness, generatedInterfaces: false })
      expect(prompt.instructions, harness.prompts.layout).not.toContain('openui-lang')
    }
  })
})

describe('generated interface fences', () => {
  it('recognizes the interface fence and the ones that may still become it', () => {
    expect(isGenUiFence('language-openui-lang')).toBe(true)
    expect(isGenUiFence('hljs language-ts')).toBe(false)
    expect(isPendingFence('language-ope', 'root = ')).toBe(true)
    expect(isPendingFence('language-openui-', '')).toBe(true)
    expect(isPendingFence('', '')).toBe(true)
    expect(isPendingFence('language-ts', 'const a = 1')).toBe(false)
    expect(isPendingFence('language-openui-lang', 'root')).toBe(false)
    expect(isWidgetFence('language-inline-html')).toBe(true)
    expect(isWidgetFence('language-html')).toBe(false)
    expect(isPendingFence('language-inline-', '<div>')).toBe(true)
    expect(isPendingFence('language-html', '<div>')).toBe(false)
    expect(isPendingFence('language-inline-html', '<div>')).toBe(false)
  })

  it('tells a closed block from one still streaming', () => {
    expect(isFenceClosed('```inline-html\n<p>a</p>\n```')).toBe(true)
    expect(isFenceClosed('```inline-html\r\n<p>a</p>\r\n```\r\n')).toBe(true)
    expect(isFenceClosed('  ````openui-lang\n  root = Stack([])\n  ````')).toBe(true)
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

  it('gives chat messages their stream, sending and saved state', () => {
    const list = source('components/chat/ChatMessageList.tsx')
    expect(list).toContain('<GenUiContext.Provider value={genUiHost}>')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source holds this template literal
    expect(list).toContain('stateKey: `${message.conversationId}:${message.id}`')
    expect(list).toContain('onUiSend={readOnly ? undefined : onUiSend}')
  })

  it("keeps the answer's prose styles out of interfaces", () => {
    const styles = readFileSync(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8')
    expect(styles).toContain(
      '.dark-glass-prose\n  :is(.genui-block, .genui-widget)\n  :is(p, h1, h2, h3, h4, ul, ol, li, a, strong, blockquote, hr, code, pre, table, th, td):not(#genui-prose-reset) {\n  all: revert-layer;'
    )
    expect(source('genui/OpenUIBlock.tsx')).toContain('className="genui-block')
    expect(source('genui/HtmlWidgetBlock.tsx')).toContain('className="genui-widget')
  })

  it('gives bot answers their stream, sending through the bot and saved state', () => {
    const bot = source('components/fleet/BotConversation.tsx')
    expect(bot).toContain('<GenUiContext.Provider value={transcriptHost}>')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source holds this template literal
    expect(bot).toContain('stateKey: `fleet:${botId}:${itemId}`')
    expect(bot).toContain('streaming={!!item.streaming}')
    expect(bot).toMatch(/\.fleetSendMessage\(bot\.id, text\)/)
    expect(bot).toContain('const interfaceSend = locked ? undefined : sendFromInterface')
  })
})
