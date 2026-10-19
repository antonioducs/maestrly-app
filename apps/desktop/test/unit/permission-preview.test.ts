import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import { freshDb, closeDb } from '../helpers/db'
import {
  BYOK_DEFAULT_RULESET,
  PermissionBroker,
  type PermissionRequest,
  YOLO_RULESET,
} from '../../src/main/chat/permission'
import { bashTool, commandPermission } from '../../src/main/chat/tools/bash'
import type { ToolContext } from '../../src/main/chat/tools/util'
import { permissionTool } from '../../src/main/fleet/instance/transcript'
import { PermissionPrompt } from '../../src/renderer/components/chat/PermissionPrompt'
import type { ChatPermissionRequest } from '../../src/shared/chat'
import {
  permissionExtraResources,
  permissionSubjectTitle,
  previewLineCount,
} from '../../src/shared/permission-preview'

const COMMAND = '{ uname -sr\n  nproc\n} > qa-check.txt\ncat qa-check.txt\npwd'
const SEGMENTS = ['{ uname -sr', 'nproc', '} > qa-check.txt', 'cat qa-check.txt', 'pwd']

beforeEach(freshDb)
afterEach(closeDb)

describe('permission preview of a multi-line command', () => {
  it('summarizes the title instead of cutting it at the first line break', () => {
    expect(previewLineCount(COMMAND)).toBe(5)
    expect(previewLineCount('ls\n')).toBe(1)
    expect(permissionSubjectTitle('Run command', COMMAND)).toBe('Run command (5 lines)')
    expect(permissionSubjectTitle('Run command', ' ls -la ')).toBe('Run command: ls -la')
    const long = permissionSubjectTitle('Run command', 'x'.repeat(500))
    expect(long.length).toBeLessThan(200)
    expect(long.endsWith('…')).toBe(true)
  })

  it('hands the bash tool command to the gate unchanged', async () => {
    const ask = vi.fn<ToolContext['ask']>(async () => {
      throw new Error('denied in test')
    })
    const ctx: ToolContext = {
      conversationId: 'c',
      projectId: 'w',
      messageId: 'm',
      toolCallId: 't',
      cwd: process.cwd(),
      signal: new AbortController().signal,
      ask,
      askQuestion: async () => [],
    }
    await expect(bashTool.execute({ command: COMMAND }, ctx)).rejects.toThrow('denied in test')
    const bash = ask.mock.calls.find(([action]) => action === 'bash')
    // PowerShell on Windows also gates the statements inside the { } block.
    expect(bash?.[1]).toEqual(process.platform === 'win32' ? commandPermission(COMMAND).resources : SEGMENTS)
    expect(bash?.[3]).toBe(COMMAND)
  })

  it('keeps the whole command on the pending request', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    let asked: PermissionRequest | null = null
    broker.on('asked', (request: PermissionRequest) => {
      asked = request
    })
    const pending = broker.assert({
      conversationId: 'c',
      projectId: 'w',
      action: 'bash',
      resources: SEGMENTS,
      preview: COMMAND,
    })
    const request = asked as PermissionRequest | null
    expect(request?.title).toBe('Run command (5 lines)')
    expect(request?.preview).toBe(COMMAND)
    broker.reply({ requestId: request!.id, reply: 'once' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('never lets a saved rule cover a command the splitter cannot read', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    const asked: PermissionRequest[] = []
    broker.on('asked', (request: PermissionRequest) => asked.push(request))
    const base = { conversationId: 'c', projectId: 'w', action: 'bash' }
    const first = broker.assert({ ...base, resources: ['echo hi'], save: ['echo *'] })
    broker.reply({ requestId: asked[0].id, reply: 'always' })
    await first
    await broker.assert({ ...base, resources: ['echo again'] })
    expect(asked).toHaveLength(1)

    const crafted = "echo $'\\'' ; rm x ; echo $'\\'' # '"
    const gate = commandPermission(crafted, 'sh')
    const pending = broker.assert({ ...base, resources: gate.resources, save: gate.save, preview: crafted })
    expect(asked).toHaveLength(2)
    expect(asked[1].save).toEqual([])
    // The command is already in the preview, so the marked resource is not listed a second time.
    expect(permissionExtraResources(asked[1])).toEqual([])
    broker.reply({ requestId: asked[1].id, reply: 'once' })
    await pending
    // Full access still runs it without asking.
    await new PermissionBroker({ rulesetFor: () => YOLO_RULESET }).assert({ ...base, resources: gate.resources })
  })

  it('renders the exact command with its line breaks in a bounded scrolling block', () => {
    const request = {
      id: 'r',
      conversationId: 'c',
      toolName: 'bash',
      action: 'bash',
      title: 'Run command (5 lines)',
      resources: [...SEGMENTS, 'network:https://example.invalid'],
      preview: COMMAND,
    } satisfies ChatPermissionRequest
    const html = renderToStaticMarkup(createElement(PermissionPrompt, { request, onDecide: vi.fn() }))
    const pre = /<pre data-testid="permission-preview" class="([^"]+)">([\s\S]*?)<\/pre>/.exec(html)
    expect(pre?.[2]).toBe(COMMAND.replace(/>/g, '&gt;'))
    expect(pre?.[1]).toContain('whitespace-pre-wrap')
    expect(pre?.[1]).toContain('font-mono')
    expect(pre?.[1]).toContain('max-h-48')
    expect(pre?.[1]).toContain('overflow-auto')
    // Segments are already in the preview; only what it does not show is listed again.
    expect(permissionExtraResources(request)).toEqual(['network:https://example.invalid'])
    expect(html).not.toContain('{ uname -sr  nproc')
    expect(html).toContain('network:https://example.invalid')
  })

  it('sends the whole command to fleet and mobile approvals', () => {
    const tool = permissionTool(
      { action: 'bash', resources: SEGMENTS, toolName: 'bash', toolCallId: 't', preview: COMMAND },
      []
    )
    expect(tool).toEqual({ name: 'bash', target: COMMAND })
    const huge = permissionTool({ action: 'bash', resources: ['x'], toolName: 'bash', preview: 'x'.repeat(9_000) }, [])
    expect(huge?.target).toMatch(/… \(1000 more characters\)$/)
  })
})
