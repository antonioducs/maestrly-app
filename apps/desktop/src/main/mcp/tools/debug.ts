import { z } from 'zod'
import { runDebugCommand } from '../../debug-bridge'
import { requestVSCodeForDebug } from '../../drawer-manager'
import { getConversation } from '../../store'
import type { McpToolContext } from './context'
import { ok, err } from './context'

export function registerDebugTools(ctx: McpToolContext): void {
  const { server, convId, t } = ctx
  // MCP controls the conversation's embedded VS Code debugger through DAP and the file bridge. The Code tab
  // must be loaded so its workspace extension host runs, and the user can see debugging in the editor.
  const DEBUG_NOTE = t('notes.debug')
  const debugTool = (
    name: string,
    op: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny> = {}
  ): void => {
    server.registerTool(name, { title, description: description + DEBUG_NOTE, inputSchema }, async (args) => {
      const cwd = getConversation(convId)?.cwd
      if (!cwd) return err(t('errors.convNotFound'))
      // Idempotently open/focus Code and load the extension before debugging without requiring a manual
      // step.
      requestVSCodeForDebug(convId)
      const r = await runDebugCommand(cwd, op, (args ?? {}) as Record<string, unknown>)
      return r.ok ? ok(JSON.stringify(r.data, null, 2)) : err(r.error ?? t('errors.debugFailed'))
    })
  }
  debugTool('debug_status', 'status', t('tools.debug_status.title'), t('tools.debug_status.description'))
  debugTool('debug_start', 'start', t('tools.debug_start.title'), t('tools.debug_start.description'), {
    program: z.string().optional().describe(t('tools.debug_start.params.program')),
    configName: z.string().optional().describe(t('tools.debug_start.params.configName')),
    stopOnEntry: z.boolean().optional().describe(t('tools.debug_start.params.stopOnEntry')),
    args: z.array(z.string()).optional().describe(t('tools.debug_start.params.args')),
  })
  debugTool('debug_stop', 'stop', t('tools.debug_stop.title'), t('tools.debug_stop.description'))
  debugTool('debug_restart', 'restart', t('tools.debug_restart.title'), t('tools.debug_restart.description'))
  debugTool('debug_pause', 'pause', t('tools.debug_pause.title'), t('tools.debug_pause.description'))
  debugTool('debug_continue', 'continue', t('tools.debug_continue.title'), t('tools.debug_continue.description'))
  debugTool('debug_step', 'step', t('tools.debug_step.title'), t('tools.debug_step.description'), {
    granularity: z.enum(['over', 'into', 'out']).optional(),
  })
  debugTool(
    'debug_set_breakpoint',
    'bp_add',
    t('tools.debug_set_breakpoint.title'),
    t('tools.debug_set_breakpoint.description'),
    {
      file: z.string().describe(t('tools.debug_set_breakpoint.params.file')),
      line: z.number().int().positive().describe(t('tools.debug_set_breakpoint.params.line')),
      condition: z.string().optional().describe(t('tools.debug_set_breakpoint.params.condition')),
    }
  )
  debugTool(
    'debug_remove_breakpoint',
    'bp_remove',
    t('tools.debug_remove_breakpoint.title'),
    t('tools.debug_remove_breakpoint.description'),
    {
      file: z.string(),
      line: z.number().int().positive(),
    }
  )
  debugTool(
    'debug_clear_breakpoints',
    'bp_clear',
    t('tools.debug_clear_breakpoints.title'),
    t('tools.debug_clear_breakpoints.description')
  )
  debugTool(
    'debug_list_breakpoints',
    'bp_list',
    t('tools.debug_list_breakpoints.title'),
    t('tools.debug_list_breakpoints.description')
  )
  debugTool('debug_stack', 'stack', t('tools.debug_stack.title'), t('tools.debug_stack.description'))
  debugTool('debug_inspect', 'inspect', t('tools.debug_inspect.title'), t('tools.debug_inspect.description'), {
    frameId: z.number().optional().describe(t('tools.debug_inspect.params.frameId')),
  })
  debugTool('debug_variables', 'variables', t('tools.debug_variables.title'), t('tools.debug_variables.description'), {
    ref: z.number().int().positive().describe(t('tools.debug_variables.params.ref')),
  })
  debugTool('debug_evaluate', 'evaluate', t('tools.debug_evaluate.title'), t('tools.debug_evaluate.description'), {
    expression: z.string().describe(t('tools.debug_evaluate.params.expression')),
    frameId: z.number().optional(),
  })
}
