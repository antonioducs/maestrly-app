import { fileURLToPath } from 'node:url'
import type { CodexSandboxPolicy, CodexThreadStartParams } from '@maestrly/codex-client'
import type { TurnSnapshot } from '@maestrly/host-protocol'
/** v2 thread/start and thread/resume mapping; sandboxPolicy belongs to turn/start.
 * ask     | on-request | workspace-write    | workspaceWrite
 * full-vm | never      | danger-full-access | dangerFullAccess
 * Managed config disables web search and notification commands.
 * MCP keys follow Codex config.toml mcp_servers.<name>.command/args/env.
 */
/** The only MCP server this runtime configures: the bot's own tool catalogue. */
export const MCP_SERVER_NAME = 'maestrly-bot'
/**
 * Fixed description of the bot's own computer. Without it the model looks for `chrome` on the
 * PATH, finds nothing and answers that no browser exists, although the managed Chromium is
 * one tool call away.
 */
export const ENVIRONMENT_INSTRUCTIONS = `## Ambiente desta área de trabalho
Você trabalha numa área de trabalho Linux (1280×800) que a pessoa pode ver ao vivo e, se quiser, controlar.
O navegador é o Chromium gerenciado desta área de trabalho, usado pelas ferramentas browser_* do servidor maestrly-bot: browser_navigate abre a página e a janela aparece na tela. Quando pedirem para abrir o navegador ou o Chrome, ou para pesquisar algo, use essas ferramentas (para pesquisar, abra https://www.google.com/search?q=<termos>).
O Chromium não fica no PATH: não o procure pelo terminal e não tente instalar outro navegador.
Para outras janelas da área de trabalho, observe com computer_screenshot e aja com computer_click, computer_type e computer_key.`
export function configuration(
  snapshot: TurnSnapshot,
  workspace: string,
  recreated: boolean,
  state = process.env.MAESTRLY_BOT_STATE ?? '/var/lib/maestrly-bot'
): { thread: CodexThreadStartParams; sandboxPolicy: CodexSandboxPolicy } {
  const full = snapshot.permissionMode === 'full-vm'
  const blocks = [snapshot.instructions, ENVIRONMENT_INSTRUCTIONS]
  if (snapshot.memory.length)
    blocks.push(
      `## Memória do bot\n${snapshot.memory
        .map((item) => item.content)
        .join('\n')
        .slice(0, 32 * 1024)}`
    )
  // A team turn carries the roster, the copies already delivered to this workspace and what
  // dependencies produced. Without this block the model would know it has a shared file but not
  // where it is, and would burn its whole tool allowance searching for it.
  if (snapshot.team) blocks.push(teamBlock(snapshot.team))
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
          [MCP_SERVER_NAME]: {
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

/**
 * The team section of a turn, in plain words. It names only what this bot may already see: the
 * roster, the copies delivered to its own workspace, approved team memory and the results of the
 * tasks it depends on. Identifiers are deliberately absent — the model acts through the
 * collaboration tools, which the Host authorizes from the session, never from text it wrote.
 */
export function teamBlock(team: NonNullable<TurnSnapshot['team']>): string {
  const lines = [`## Equipe ${team.teamName}`]
  if (team.objective) lines.push(`Objetivo: ${team.objective}`)
  lines.push(
    team.role === 'coordinator'
      ? 'Você coordena este trabalho.'
      : 'Você executa uma tarefa desta equipe.'
  )
  if (team.members.length)
    lines.push(
      '',
      'Participantes:',
      ...team.members.map((member) => `- ${member.name}${member.role ? ` (${member.role})` : ''}${member.coordinator ? ' — coordena' : ''}`)
    )
  if (team.resources.length)
    lines.push(
      '',
      'Arquivos compartilhados já copiados para o seu espaço de trabalho (use estes caminhos, não procure em outro lugar):',
      ...team.resources.map((resource) => `- ${resource.path} — ${resource.name}, ${resource.size} bytes, ${resource.origin}`)
    )
  const useful = team.dependencyResults.filter((dependency) => dependency.summary)
  if (useful.length)
    lines.push(
      '',
      'Resultados que você recebeu:',
      ...useful.map((dependency) => `- ${dependency.botName} (${dependency.status}): ${dependency.summary}`)
    )
  if (team.memory.length) lines.push('', 'Anotações da equipe:', ...team.memory.map((item) => `- ${item.content}`))
  lines.push(
    '',
    `Orçamento restante deste trabalho: cerca de ${team.remaining.toolCalls} ações. Trabalhe direto ao ponto e não repita buscas.`
  )
  return lines.join('\n').slice(0, 32 * 1024)
}
