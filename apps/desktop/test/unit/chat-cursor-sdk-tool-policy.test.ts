import { describe, expect, it, vi } from 'vitest'
import { cursorCustomToolsOnlyPolicy } from '../../src/main/chat/cursor-sdk/tool-policy'
import { buildCursorCustomTools, withCursorCustomToolPermissionGate } from '../../src/main/chat/cursor-sdk/custom-tools'

describe('Cursor host tool policy', () => {
  it('offers only host MCP callbacks, including on repeated session setup', () => {
    const first = cursorCustomToolsOnlyPolicy()
    first.tools.push('shell')
    expect(cursorCustomToolsOnlyPolicy()).toEqual({ tools: ['mcp'], customToolsEnabled: true })
  })

  it('preserves arguments and tool-call identity through the SDK callback', async () => {
    const execute = vi.fn(() => 'result')
    const tools = buildCursorCustomTools([{ name: 'read', description: 'Read a file', execute }])
    expect(await tools.read!.execute({ path: 'file.txt' }, { toolCallId: 't1' })).toBe('result')
    expect(execute).toHaveBeenCalledWith({ path: 'file.txt' }, 't1')
  })

  it('denies before invoking the tool and propagates broker errors', async () => {
    const execute = vi.fn(() => 'result')
    const definition = { name: 'write', description: 'Write a file', execute }
    const denied = withCursorCustomToolPermissionGate(definition, () => 'deny')
    expect(await denied.execute({})).toMatchObject({ isError: true })
    expect(execute).not.toHaveBeenCalled()
    const failed = withCursorCustomToolPermissionGate(definition, () => {
      throw new Error('broker closed')
    })
    await expect(failed.execute({})).rejects.toThrow('broker closed')
    expect(execute).not.toHaveBeenCalled()
  })

  it('executes after approval and forwards the call identity to the broker', async () => {
    const execute = vi.fn(() => 'result')
    const gate = vi.fn(async (): Promise<'allow'> => 'allow')
    const tool = withCursorCustomToolPermissionGate({ name: 'write', description: 'Write', execute }, gate)
    expect(await tool.execute({ content: 'text' }, 't2')).toBe('result')
    expect(gate).toHaveBeenCalledWith({ name: 'write', args: { content: 'text' }, toolCallId: 't2' })
  })
})
