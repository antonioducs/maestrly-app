import { fileURLToPath } from 'node:url'
import type { CodexSandboxPolicy, CodexThreadStartParams } from '@maestrly/codex-client'
import type { TurnSnapshot } from '@maestrly/host-protocol'
/** v2 thread/start and thread/resume mapping; sandboxPolicy belongs to turn/start.
 * ask     | on-request | workspace-write    | workspaceWrite
 * full-vm | never      | danger-full-access | dangerFullAccess
 * Managed config disables web search and notification commands.
 * MCP keys follow Codex config.toml mcp_servers.<name>.command/args/env.
 */
export function configuration(
  snapshot: TurnSnapshot,
  workspace: string,
  recreated: boolean,
  state = process.env.MAESTRLY_BOT_STATE ?? '/var/lib/maestrly-bot'
): { thread: CodexThreadStartParams; sandboxPolicy: CodexSandboxPolicy } {
  const full = snapshot.permissionMode === 'full-vm'
  const blocks = [snapshot.instructions]
  if (snapshot.memory.length)
    blocks.push(
      `## Memória do bot\n${snapshot.memory
        .map((item) => item.content)
        .join('\n')
        .slice(0, 32 * 1024)}`
    )
  if (snapshot.contextSummary) blocks.push(snapshot.contextSummary)
  if (recreated && snapshot.recentMessages.length)
    blocks.push(
      `## Contexto recente\n${snapshot.recentMessages
        .map((item) => `${item.role}: ${item.content}`)
        .join('\n')
        .slice(-32 * 1024)}`
    )
  return {
    thread: {
      approvalPolicy: full ? 'never' : 'on-request',
      sandbox: full ? 'danger-full-access' : 'workspace-write',
      cwd: workspace,
      model: snapshot.model?.model,
      developerInstructions: blocks.join('\n\n'),
      config: {
        features: { web_search_request: false },
        mcp_servers: {
          'maestrly-bot': {
            command: process.execPath,
            args: [
              process.env.MAESTRLY_BOT_MCP_MAIN ?? fileURLToPath(new URL('../../tools/mcp-main.js', import.meta.url)),
            ],
            env: {
              MAESTRLY_BOT_STATE: state,
              MAESTRLY_BOT_TURN_ID: snapshot.turnId,
            },
          },
        },
        notify: [],
      },
    },
    sandboxPolicy: full
      ? { type: 'dangerFullAccess' }
      : {
          type: 'workspaceWrite',
          writableRoots: [workspace],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
  }
}
