import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { APP_TOOL_POLICY, appToolAllowed, appToolMetadata } from '../../src/main/chat/tool-policy'
import { buildAppTools } from '../../src/main/chat/mcp'
import { createLocalMemory, getLocalMemory } from '../../src/main/memory/local-memory-service'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'

interface ToolShape {
  name: string
  props: string[]
  required: string[]
  description?: string
}

const shape = (name: string, props: string[] = [], required: string[] = []): ToolShape => ({
  name,
  props,
  required,
})

const EXPECTED_TOOL_NAMES = [
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_wait_for',
  'browser_snapshot',
  'browser_click',
  'browser_double_click',
  'browser_right_click',
  'browser_drag',
  'browser_type',
  'browser_press_key',
  'browser_read_text',
  'browser_screenshot',
  'browser_evaluate',
  'browser_mouse_move',
  'browser_scroll',
  'browser_console_logs',
  'browser_network_logs',
  'browser_clear_logs',
  'browser_set_dialog_behavior',
  'browser_tabs',
  'browser_switch_tab',
  'browser_new_tab',
  'browser_close_tab',
  'terminal_create',
  'terminal_list',
  'terminal_send',
  'terminal_run',
  'terminal_read',
  'terminal_snapshot',
  'terminal_signal',
  'terminal_close',
  'terminal_resize',
  'terminal_focus',
  'terminal_clear',
  'notes_list_pages',
  'notes_create_page',
  'notes_read_page',
  'notes_write_page',
  'notes_append_page',
  'notes_delete_page',
  'notes_quick_append',
  'project_notes_list_pages',
  'project_notes_create_page',
  'project_notes_read_page',
  'project_notes_write_page',
  'project_notes_append_page',
  'project_notes_delete_page',
  'project_notes_quick_append',
  'memory_search',
  'memory_list',
  'memory_read',
  'memory_upsert',
  'memory_archive',
  'memory_restore',
  'memory_forget',
  'memory_promote_to_shared',
  'memory_write',
  'memory_append',
  'debug_status',
  'debug_start',
  'debug_stop',
  'debug_restart',
  'debug_pause',
  'debug_continue',
  'debug_step',
  'debug_set_breakpoint',
  'debug_remove_breakpoint',
  'debug_clear_breakpoints',
  'debug_list_breakpoints',
  'debug_stack',
  'debug_inspect',
  'debug_variables',
  'debug_evaluate',
] as const

const LINKED_BOARD_TOOL_NAMES = [
  'board_list_boards', 'board_get_board', 'board_search_cards', 'board_card_history', 'board_create_card',
  'board_comment',
  'board_create_subtask',
  'board_get_card',
  'board_list_cards',
  'board_move_card',
  'board_update_card',
] as const

const EXPECTED_SHAPES: ToolShape[] = [
  shape('browser_navigate', ['url'], ['url']),
  shape('browser_back'),
  shape('browser_forward'),
  shape('browser_reload'),
  shape('browser_wait_for', ['network_idle', 'selector', 'text', 'timeout_ms']),
  shape('browser_snapshot'),
  shape('browser_click', ['ref'], ['ref']),
  shape('browser_double_click', ['ref'], ['ref']),
  shape('browser_right_click', ['ref'], ['ref']),
  shape('browser_drag', ['from_ref', 'to_ref'], ['from_ref', 'to_ref']),
  shape('browser_type', ['clear', 'ref', 'text'], ['ref', 'text']),
  shape('browser_press_key', ['key', 'modifiers'], ['key']),
  shape('browser_read_text'),
  shape('browser_screenshot'),
  shape('browser_evaluate', ['expression'], ['expression']),
  shape('browser_mouse_move', ['x', 'y'], ['x', 'y']),
  shape('browser_scroll', ['container', 'dx', 'dy', 'selector', 'to', 'x', 'y']),
  shape('browser_console_logs', ['level', 'limit']),
  shape('browser_network_logs', ['limit', 'onlyErrors']),
  shape('browser_clear_logs'),
  shape('browser_set_dialog_behavior', ['accept', 'prompt_text'], ['accept']),
  shape('browser_tabs'),
  shape('browser_switch_tab', ['index'], ['index']),
  shape('browser_new_tab', ['url']),
  shape('browser_close_tab', ['index'], ['index']),
  shape('terminal_create', ['cols', 'cwd', 'rows']),
  shape('terminal_list'),
  shape('terminal_send', ['id', 'text'], ['id', 'text']),
  shape('terminal_run', ['command', 'id', 'timeout_ms'], ['command', 'id']),
  shape('terminal_read', ['id', 'max_chars'], ['id']),
  shape('terminal_snapshot', ['id'], ['id']),
  shape('terminal_signal', ['id', 'signal'], ['id', 'signal']),
  shape('terminal_close', ['id'], ['id']),
  shape('terminal_resize', ['cols', 'id', 'rows'], ['cols', 'id', 'rows']),
  shape('terminal_focus', ['id'], ['id']),
  shape('terminal_clear', ['id'], ['id']),
  shape('notes_list_pages'),
  shape('notes_create_page', ['parentId', 'title'], ['title']),
  shape('notes_read_page', ['pageId'], ['pageId']),
  shape('notes_write_page', ['content', 'pageId'], ['content', 'pageId']),
  shape('notes_append_page', ['pageId', 'text'], ['pageId', 'text']),
  shape('notes_delete_page', ['pageId'], ['pageId']),
  shape('notes_quick_append', ['text'], ['text']),
  shape('project_notes_list_pages'),
  shape('project_notes_create_page', ['parentId', 'title'], ['title']),
  shape('project_notes_read_page', ['pageId'], ['pageId']),
  shape('project_notes_write_page', ['content', 'pageId'], ['content', 'pageId']),
  shape('project_notes_append_page', ['pageId', 'text'], ['pageId', 'text']),
  shape('project_notes_delete_page', ['pageId'], ['pageId']),
  shape('project_notes_quick_append', ['text'], ['text']),
  shape('memory_search', ['limit', 'query'], ['query']),
  shape('memory_list', ['limit', 'pinned', 'scope', 'source', 'status', 'tag', 'type']),
  shape('memory_read', ['id']),
  shape(
    'memory_upsert',
    ['content', 'id', 'importance', 'origin_message_id', 'pinned', 'scope', 'supersedes_id', 'tags', 'title', 'type'],
    ['content', 'title', 'type']
  ),
  shape('memory_archive', ['id'], ['id']),
  shape('memory_restore', ['id'], ['id']),
  shape('memory_forget', ['confirm', 'id'], ['confirm', 'id']),
  shape('memory_promote_to_shared', ['id', 'overwrite', 'repo', 'scope', 'slug', 'type'], ['id']),
  shape('memory_write', ['content'], ['content']),
  shape('memory_append', ['text'], ['text']),
  shape('debug_status'),
  shape('debug_start', ['args', 'configName', 'program', 'stopOnEntry']),
  shape('debug_stop'),
  shape('debug_restart'),
  shape('debug_pause'),
  shape('debug_continue'),
  shape('debug_step', ['granularity']),
  shape('debug_set_breakpoint', ['condition', 'file', 'line'], ['file', 'line']),
  shape('debug_remove_breakpoint', ['file', 'line'], ['file', 'line']),
  shape('debug_clear_breakpoints'),
  shape('debug_list_breakpoints'),
  shape('debug_stack'),
  shape('debug_inspect', ['frameId']),
  shape('debug_variables', ['ref'], ['ref']),
  shape('debug_evaluate', ['expression', 'frameId'], ['expression']),
]

async function listToolInventory(convId: string, includeDescriptions = false): Promise<ToolShape[]> {
  const { buildAppToolsServer } = await import('../../src/main/app-tools-registry')
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const server = buildAppToolsServer(convId)
  const client = new Client({ name: 'inventory-test-client', version: '1.0.0' })

  try {
    await server.connect(serverT)
    await client.connect(clientT)
    const tools: Array<{
      name: string
      description?: string
      inputSchema?: { properties?: Record<string, unknown>; required?: string[] }
    }> = []
    let cursor: string | undefined
    do {
      const listed = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...((listed.tools ?? []) as typeof tools))
      cursor = listed.nextCursor
    } while (cursor)

    return tools.map((tool) => ({
      name: tool.name,
      props: Object.keys(tool.inputSchema?.properties ?? {}).sort(),
      required: [...(tool.inputSchema?.required ?? [])].sort(),
      ...(includeDescriptions && tool.description ? { description: tool.description } : {}),
    }))
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

async function callAppTool(convId: string, name: string, args: Record<string, unknown>) {
  const { buildAppToolsServer } = await import('../../src/main/app-tools-registry')
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const server = buildAppToolsServer(convId)
  const client = new Client({ name: 'memory-tool-test-client', version: '1.0.0' })
  try {
    await server.connect(serverT)
    await client.connect(clientT)
    return await client.callTool({ name, arguments: args })
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

describe('MCP app tools inventory', () => {
  // buildServer reads getConversation to gate tools by surface (#710): notes_* requires a regular
  // conversation with the Notes tab. Without a database, getConversation fails and the full tool
  // inventory cannot register. Create a fresh database and regular conversation, then pass its ID
  // to buildServer.
  let convId: string
  let workspaceId: string

  beforeEach(() => {
    freshDb()
    const ws = makeWorkspace()
    workspaceId = ws.id
    convId = makeConversation(ws.id).id
  })
  afterEach(closeDb)

  it('keeps the registered tool names and input schema shapes stable', async () => {
    const shapes = await listToolInventory(convId)
    expect(shapes.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES)
    expect(shapes).toEqual(EXPECTED_SHAPES)
  })

  it('advertises the screenshot fallback in the public app-tool description', async () => {
    const screenshot = (await listToolInventory(convId, true)).find((tool) => tool.name === 'browser_screenshot')
    expect(screenshot?.description).toContain('Image-capable models receive it visually')
    expect(screenshot?.description).toContain('image interpreter is configured')
    expect(screenshot?.description).toContain('omission note')
    // Large viewports are automatically scaled down, never cropped, to fit the image limit.
    expect(screenshot?.description).toContain('fit the model image limit')
    expect(screenshot?.description).toContain('never cropped')
  })

  it('advertises deliberate narrow memory lookup and tracks an explicit read', async () => {
    const search = (await listToolInventory(convId, true)).find((tool) => tool.name === 'memory_search')
    expect(search?.description).toContain('Narrow hybrid search')
    expect(search?.description).toContain('skip trivial or self-contained requests')

    const memory = createLocalMemory({
      workspaceId,
      title: 'Release constraint',
      content: 'Release only after verification.',
      type: 'constraint',
      source: 'user',
    }).memory
    expect(getLocalMemory(workspaceId, memory.id)?.useCount).toBe(0)

    await callAppTool(convId, 'memory_read', { id: memory.id })

    expect(getLocalMemory(workspaceId, memory.id)?.useCount).toBe(1)
    expect(getLocalMemory(workspaceId, memory.id)?.lastUsedAt).toEqual(expect.any(Number))
  })

  it('classifies every registered app-tool exactly once with no orphan policy entries', async () => {
    const registered = (await listToolInventory(convId)).map((tool) => tool.name).sort()
    const classified = Object.keys(APP_TOOL_POLICY).filter(
      (name) => !LINKED_BOARD_TOOL_NAMES.includes(name as (typeof LINKED_BOARD_TOOL_NAMES)[number])
    ).sort()
    expect(registered).toHaveLength(75)
    expect(classified).toEqual(registered)
  })

  it('builds the exact Agent app catalog', async () => {
    const plan = await buildAppTools({ conversationId: convId, mode: 'plan', gate: async () => {} })
    try {
      const expected = EXPECTED_TOOL_NAMES.filter((name) => appToolAllowed('plan', name)).sort()
      expect(Object.keys(plan.tools).sort()).toEqual(expected)
      for (const name of expected) expect(plan.tools[name].metadata, name).toEqual(appToolMetadata(name))
    } finally {
      await plan.close()
    }

    const agent = await buildAppTools({ conversationId: convId, mode: 'agent', gate: async () => {} })
    try {
      expect(Object.keys(agent.tools).sort()).toEqual(EXPECTED_TOOL_NAMES.slice().sort())
      expect(agent.tools.review_plan).toBeUndefined()
    } finally {
      await agent.close()
    }
  })

  it('keeps critical Plan/Ask policy sentinels explicit', () => {
    expect(appToolAllowed('plan', 'notes_write_page')).toBe(true)
    expect(appToolAllowed('ask', 'memory_search')).toBe(true)
    expect(appToolAllowed('ask', 'memory_list')).toBe(true)
    expect(appToolAllowed('ask', 'memory_append')).toBe(false)
    expect(appToolAllowed('plan', 'browser_read_text')).toBe(true)
    expect(appToolAllowed('ask', 'terminal_read')).toBe(true)
    expect(appToolAllowed('plan', 'review_plan')).toBe(false)
    expect(appToolAllowed('ask', 'notes_delete_page')).toBe(false)
    expect(appToolAllowed('plan', 'memory_write')).toBe(false)
    expect(appToolAllowed('ask', 'browser_evaluate')).toBe(false)
    expect(appToolAllowed('plan', 'terminal_run')).toBe(false)
    expect(appToolAllowed('ask', 'debug_status')).toBe(false)
  })
})
