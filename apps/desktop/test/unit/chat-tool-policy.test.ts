import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import {
  APP_TOOL_POLICY,
  DEFERRED_LOADING_METADATA,
  EXTERNAL_MCP_RESTRICTED_METADATA,
  EXTERNAL_MCP_WRAPPER_METADATA,
  appToolAllowed,
  appToolDeferrable,
  appToolMetadata,
  deferredLoadingToolNames,
  externalMcpToolAllowed,
  withoutExternalMcpWrappers,
} from '../../src/main/chat/tool-policy'
import { providerDefersTools } from '../../src/main/chat/catalog'
import { hasSubagentMutatingCapability, isSubagentReadOnly, selectSubagentToolNames } from '../../src/main/chat/tools'

describe('external MCP tool policy', () => {
  it.each(['plan', 'ask'] as const)('fails closed in %s unless annotations are explicitly read-only', (mode) => {
    expect(externalMcpToolAllowed(mode, { readOnlyHint: true })).toBe(true)
    expect(externalMcpToolAllowed(mode, { readOnlyHint: true, futureHint: 'accepted' })).toBe(true)
    expect(externalMcpToolAllowed(mode, undefined)).toBe(false)
    expect(externalMcpToolAllowed(mode, null)).toBe(false)
    expect(externalMcpToolAllowed(mode, [])).toBe(false)
    expect(externalMcpToolAllowed(mode, { readOnlyHint: false })).toBe(false)
    expect(externalMcpToolAllowed(mode, { readOnlyHint: 'true' })).toBe(false)
    expect(externalMcpToolAllowed(mode, { readOnlyHint: true, destructiveHint: true })).toBe(false)
    expect(externalMcpToolAllowed(mode, { readOnlyHint: true, openWorldHint: 'yes' })).toBe(false)
    expect(externalMcpToolAllowed(mode, { readOnlyHint: true, title: 42 })).toBe(false)
  })

  it('preserves the Agent catalog regardless of annotations', () => {
    for (const annotations of [
      undefined,
      { readOnlyHint: false },
      { readOnlyHint: 'invalid' },
      { destructiveHint: true },
    ]) {
      expect(externalMcpToolAllowed('agent', annotations)).toBe(true)
    }
  })

  it('gives Design the exact Agent MCP policy', () => {
    for (const annotations of [undefined, { readOnlyHint: false }, { destructiveHint: true }]) {
      expect(externalMcpToolAllowed('design', annotations)).toBe(externalMcpToolAllowed('agent', annotations))
    }
  })

  it('marks accepted external tools read-only but never infers parallel safety', () => {
    expect(EXTERNAL_MCP_RESTRICTED_METADATA).toEqual({ readOnly: true, parallelSafe: false })
  })
})

describe('Maestrly app-tool policy', () => {
  it('classifies the complete 136-tool product-policy universe', () => {
    expect(Object.keys(APP_TOOL_POLICY)).toHaveLength(136)
    for (const entry of Object.values(APP_TOOL_POLICY)) {
      expect(entry).toEqual({
        allowedInPlanAsk: expect.any(Boolean),
        readOnly: expect.any(Boolean),
        parallelSafe: expect.any(Boolean),
      })
    }
  })

  it.each(['plan', 'ask'] as const)('applies the approved allowlist in %s', (mode) => {
    for (const name of [
      'notes_read_page',
      'notes_create_page',
      'notes_write_page',
      'notes_append_page',
      'memory_read',
      'memory_search',
      'memory_list',
      'browser_navigate',
      'browser_read_text',
      'browser_new_tab',
      'browser_close_tab',
      'terminal_list',
      'terminal_read',
      'terminal_snapshot',
    ]) {
      expect(appToolAllowed(mode, name), name).toBe(true)
    }

    for (const name of [
      'review_plan',
      'notes_delete_page',
      'memory_write',
      'memory_append',
      'memory_upsert',
      'memory_archive',
      'browser_click',
      'browser_type',
      'browser_evaluate',
      'terminal_create',
      'terminal_run',
      'debug_status',
      'unknown_tool',
    ]) {
      expect(appToolAllowed(mode, name), name).toBe(false)
    }
  })

  it('keeps capability, read-only and parallel-safe as independent decisions', () => {
    expect(appToolMetadata('notes_write_page')).toEqual({ readOnly: false, parallelSafe: false })
    expect(appToolMetadata('notes_read_page')).toEqual({ readOnly: true, parallelSafe: false })
    expect(appToolMetadata('debug_status')).toEqual({ readOnly: true, parallelSafe: false })
    expect(appToolAllowed('plan', 'debug_status')).toBe(false)
    expect(appToolMetadata('unknown_tool')).toBeUndefined()
  })

  it('preserves Agent app-tools except the blocking MCP review_plan duplicate', () => {
    expect(appToolAllowed('agent', 'browser_click')).toBe(true)
    expect(appToolAllowed('agent', 'unknown_future_tool')).toBe(true)
    expect(appToolAllowed('agent', 'review_plan')).toBe(false)
  })

  it('gives Design the exact Agent app-tool policy', () => {
    for (const name of [...Object.keys(APP_TOOL_POLICY), 'unknown_future_tool', 'review_plan']) {
      expect(appToolAllowed('design', name), name).toBe(appToolAllowed('agent', name))
    }
  })
})

describe('subagent tool surface', () => {
  it('lets the built-in worker inherit the parent host surface but keeps explore read-only', () => {
    const host = {
      browser_screenshot: {},
      browser_snapshot: {},
      browser_read_text: {},
      browser_click: {},
      generate_image: {},
      ext_mcp__lookup: { metadata: { readOnly: true, parallelSafe: false } },
    } as unknown as ToolSet

    const worker = selectSubagentToolNames({
      definition: { name: 'general-purpose', source: 'built-in', tools: ['read', 'bash'] },
      readOnly: false,
      providedHostTools: host,
    })
    expect([...worker]).toEqual(
      expect.arrayContaining([
        'browser_screenshot',
        'browser_snapshot',
        'browser_read_text',
        'browser_click',
        'generate_image',
        'ext_mcp__lookup',
      ])
    )

    const explore = selectSubagentToolNames({
      definition: { name: 'explore', source: 'built-in' },
      readOnly: true,
      providedHostTools: host,
    })
    expect([...explore]).toEqual(
      expect.arrayContaining(['browser_screenshot', 'browser_snapshot', 'browser_read_text', 'ext_mcp__lookup'])
    )
    expect(explore).not.toContain('browser_click')
    expect(explore).not.toContain('generate_image')
  })

  it('keeps a custom explicit tools list as an allowlist and classifies generate_image as mutating', () => {
    const custom = selectSubagentToolNames({
      definition: { name: 'screenshot-reviewer', source: 'project', tools: ['read', 'browser_screenshot'] },
      readOnly: true,
      providedHostTools: { browser_screenshot: {}, browser_snapshot: {} } as unknown as ToolSet,
    })
    expect(custom).toEqual(new Set(['read', 'browser_screenshot']))
    expect(hasSubagentMutatingCapability(['read', 'generate_image'])).toBe(true)
    expect(isSubagentReadOnly('agent', ['read', 'generate_image'])).toBe(false)
    expect(isSubagentReadOnly('plan', ['read', 'generate_image'])).toBe(true)
    expect(isSubagentReadOnly('ask', ['generate_image'])).toBe(true)

    const imageOnly = selectSubagentToolNames({
      definition: { name: 'image-maker', source: 'project', tools: ['generate_image'] },
      readOnly: isSubagentReadOnly('agent', ['generate_image']),
      providedHostTools: { generate_image: {} } as unknown as ToolSet,
    })
    expect(imageOnly).toEqual(new Set(['generate_image']))
    const imageOnlyPlan = selectSubagentToolNames({
      definition: { name: 'image-maker', source: 'project', tools: ['generate_image'] },
      readOnly: isSubagentReadOnly('plan', ['generate_image']),
      providedHostTools: { generate_image: {} } as unknown as ToolSet,
    })
    expect(imageOnlyPlan).not.toContain('generate_image')
  })

  it('classifies explicitly configured host tools by their read-only contract', () => {
    const host = {
      browser_click: {},
      browser_screenshot: {},
      notes_write_page: {},
      ext_mcp__lookup: { metadata: { readOnly: true, parallelSafe: false } },
    } as unknown as ToolSet

    // Host tools without a proven read-only contract make the child a worker...
    expect(isSubagentReadOnly('agent', ['browser_click'], host)).toBe(false)
    expect(isSubagentReadOnly('agent', ['notes_write_page'], host)).toBe(false)
    expect(isSubagentReadOnly('agent', ['browser_click'])).toBe(false) // static policy applies without a surface
    // ...and the explicit user allowlist is honored without filtering in the mutable branch.
    const clicker = selectSubagentToolNames({
      definition: { name: 'browser-worker', source: 'project', tools: ['browser_click', 'browser_screenshot'] },
      readOnly: isSubagentReadOnly('agent', ['browser_click', 'browser_screenshot'], host),
      providedHostTools: host,
    })
    expect(clicker).toEqual(new Set(['browser_click', 'browser_screenshot']))

    // Host tools with a proven read-only contract keep the child read-only and filter the allowlist.
    expect(isSubagentReadOnly('agent', ['browser_screenshot'], host)).toBe(true)
    const screenshotOnly = selectSubagentToolNames({
      definition: { name: 'screenshot-only', source: 'project', tools: ['browser_screenshot'] },
      readOnly: isSubagentReadOnly('agent', ['browser_screenshot'], host),
      providedHostTools: host,
    })
    expect(screenshotOnly).toEqual(new Set(['browser_screenshot']))
    expect(screenshotOnly).not.toContain('browser_click')

    // MCP with a proven readOnlyHint does not become a worker.
    expect(isSubagentReadOnly('agent', ['ext_mcp__lookup'], host)).toBe(true)
    // Unknown external MCP without a contract fails closed as mutable.
    expect(isSubagentReadOnly('agent', ['ext_mcp__opaque'], host)).toBe(false)
    expect(isSubagentReadOnly('agent', ['ext_mcp__opaque'])).toBe(false)

    // Plan/Ask remain clamped to read-only regardless of the surface.
    expect(isSubagentReadOnly('plan', ['browser_click'], host)).toBe(true)
    expect(isSubagentReadOnly('ask', ['notes_write_page'], host)).toBe(true)
    expect(isSubagentReadOnly('plan', ['ext_mcp__opaque'], host)).toBe(true)

    // Parent-only meta tools never make the child mutable.
    expect(isSubagentReadOnly('agent', ['todo_write'], host)).toBe(true)
    expect(isSubagentReadOnly('agent', ['use_skill'], host)).toBe(true)
    expect(isSubagentReadOnly('agent', ['task'], host)).toBe(true)
    expect(isSubagentReadOnly('agent', ['read', 'grep', 'glob'], host)).toBe(true)
  })

  it('exposes the host skill loader only through the explicit Maestro capability', () => {
    const definition = {
      name: 'frontend',
      source: 'maestro-pool',
      virtual: true,
      baseAgentName: 'explore',
      tools: ['read', 'use_skill'],
    }
    const providedHostTools = new Set(['read', 'use_skill'])

    expect(selectSubagentToolNames({ definition, readOnly: false, providedHostTools })).toEqual(new Set(['read']))
    expect(
      selectSubagentToolNames({
        definition,
        readOnly: false,
        providedHostTools,
        allowSkillLoader: true,
      })
    ).toEqual(new Set(['read', 'use_skill']))
  })
})

describe('deferred tool loading policy', () => {
  it('defers app tools except the ones the prompt asks the model to use unprompted', () => {
    for (const name of [
      'terminal_run',
      'browser_click',
      'notes_write_page',
      'project_notes_list_pages',
      'debug_start',
      'artifact_create',
      'whiteboard_create',
      'whiteboard_read',
    ]) {
      expect(appToolDeferrable(name), name).toBe(true)
    }
    for (const name of [
      'memory_search',
      'memory_read',
      'memory_upsert',
      'history_search',
      'history_read',
      'plan_read',
      'preview_interface',
    ]) {
      expect(appToolDeferrable(name), name).toBe(false)
    }
    for (const name of [
      'memory_list',
      'memory_archive',
      'memory_restore',
      'memory_forget',
      'memory_promote_to_shared',
    ]) {
      expect(appToolDeferrable(name), name).toBe(true)
    }
    // Bot-only tools belong to no group and are looked up like the rest.
    expect(appToolDeferrable('computer_click')).toBe(true)
  })

  it('collects the deferred tools of a set by their metadata, not by their names', () => {
    const tools = {
      a: { metadata: DEFERRED_LOADING_METADATA },
      b: { metadata: { readOnly: true } },
      c: {},
      d: { metadata: { ...EXTERNAL_MCP_RESTRICTED_METADATA, ...DEFERRED_LOADING_METADATA } },
    }
    expect([...deferredLoadingToolNames(tools)].sort()).toEqual(['a', 'd'])
  })

  it('removes only the typed wrappers of external MCP tools', () => {
    const tools = {
      read: {},
      mcp_search: { metadata: EXTERNAL_MCP_RESTRICTED_METADATA },
      terminal_run: { metadata: DEFERRED_LOADING_METADATA },
      server__lookup: { metadata: { ...DEFERRED_LOADING_METADATA, ...EXTERNAL_MCP_WRAPPER_METADATA } },
    }
    expect(Object.keys(withoutExternalMcpWrappers(tools))).toEqual(['read', 'mcp_search', 'terminal_run'])
  })

  it('knows which providers keep a deferred tool out of their requests', () => {
    expect(providerDefersTools('builtin_claude_subscription')).toBe(true)
    expect(providerDefersTools('builtin_codex_subscription')).toBe(true)
    expect(providerDefersTools('builtin_github_copilot_subscription')).toBe(true)
    expect(providerDefersTools('builtin_cursor_subscription')).toBe(false)
    expect(providerDefersTools('builtin_antigravity_subscription')).toBe(false)
    expect(providerDefersTools('openai')).toBe(false)
    expect(providerDefersTools(null)).toBe(false)
  })

  it('lets a read-only subagent reach external tools through mcp_read only', () => {
    const providedHostTools = {
      mcp_search: { metadata: EXTERNAL_MCP_RESTRICTED_METADATA },
      mcp_read: { metadata: EXTERNAL_MCP_RESTRICTED_METADATA },
      mcp_call: {},
    } as unknown as ToolSet
    const selected = selectSubagentToolNames({
      definition: { name: 'explore', source: 'builtin' } as never,
      readOnly: true,
      providedHostTools,
    })
    expect(selected.has('mcp_read')).toBe(true)
    expect(selected.has('mcp_search')).toBe(true)
    expect(selected.has('mcp_call')).toBe(false)
  })
})
