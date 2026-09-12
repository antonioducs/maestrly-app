import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

const markdownSource = source('src/renderer/components/MarkdownViewer.tsx')
const messageListSource = source('src/renderer/components/chat/ChatMessageList.tsx')
const subagentSource = source('src/renderer/components/chat/SubagentCard.tsx')
const chatViewSource = source('src/renderer/components/chat/ChatView.tsx')
const preloadSource = source('src/preload/api-plan.ts')

describe('local chat references → embedded VS Code', () => {
  it('routes local links and inline code through the parser without changing external URLs', () => {
    expect(markdownSource).toContain("import { parseLocalFileReference } from '../../shared/file-reference'")
    expect(markdownSource).toContain('urlTransform={markdownUrlTransform}')
    expect(markdownSource).toContain(
      "key === 'href' && parseLocalFileReference(value) ? value : defaultUrlTransform(value)"
    )
    expect(markdownSource).toContain('onOpenReference?.(reference.filePath, reference.startLine, reference.endLine)')
    expect(markdownSource).toContain('void window.api.openExternalUrl(url)')
    expect(markdownSource).toContain(
      'onClick={() => onOpenReference(reference.filePath, reference.startLine, reference.endLine)}'
    )
    expect(markdownSource).toContain('const insideLink = useContext(MarkdownLinkContext)')
    expect(markdownSource).toContain('!className && !insideLink ? parseLocalFileReference(text) : null')
  })

  it('propagates the callback through assistant response parts and auxiliary surfaces', () => {
    expect(messageListSource.match(/onOpenMention=\{onOpenMention\}/g)?.length ?? 0).toBeGreaterThanOrEqual(8)
    expect(messageListSource).toContain('<SubagentCard')
    expect(messageListSource).toContain('conversationId={conversationId}')
    expect(messageListSource).toContain('messageId={messageId}')
    expect(subagentSource).toContain('<MarkdownViewer markdown={part.state.output} onOpenMention={onOpenMention} />')
  })

  it('transports range start and end to the existing IPC channel', () => {
    expect(chatViewSource).toContain('openPlanFile(conversationId, relPath, startLine, endLine)')
    expect(preloadSource).toContain(
      'openPlanFile: (convId: string, filePath: string, line?: number, endLine?: number): Promise<void>'
    )
    expect(preloadSource).toContain("ipcRenderer.invoke('plan:open-file', convId, filePath, line, endLine)")
  })
})
