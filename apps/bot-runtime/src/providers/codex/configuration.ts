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
/** Per-bot extensions already applied to this runtime, as the thread configuration needs them. */
export interface ConfiguredExtensions {
  mcpServers: Record<string, unknown>
  skills: string[]
}
export function configuration(
  snapshot: TurnSnapshot,
  workspace: string,
  recreated: boolean,
  state = process.env.MAESTRLY_BOT_STATE ?? '/var/lib/maestrly-bot',
  extensions?: ConfiguredExtensions
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
  // Reference time and what a suggestion actually is. Without this the model either invents a
  // time zone or announces a routine that does not exist yet.
  if (snapshot.routines) blocks.push(routinesBlock(snapshot.routines))
  if (extensions && (extensions.skills.length || Object.keys(extensions.mcpServers).length)) blocks.push(extensionsBlock(extensions))
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
        // The person's servers first, the bot's own catalogue last: whatever a person named,
        // the tool server the Host authorizes is always the one under `maestrly-bot`.
        mcp_servers: {
          ...(extensions?.mcpServers ?? {}),
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
 * The extensions a person configured for this bot, by name only. Codex already offers the tools
 * and reads the skills; this block exists so the model knows they were put there on purpose and
 * does not go looking for them elsewhere.
 */
export function extensionsBlock(extensions: ConfiguredExtensions): string {
  const lines = ['## Extensões deste bot']
  const servers = Object.keys(extensions.mcpServers)
  if (servers.length) lines.push(`Servidores MCP configurados pela pessoa: ${servers.join(', ')}. Use as ferramentas deles quando forem úteis.`)
  if (extensions.skills.length) lines.push(`Skills instaladas: ${extensions.skills.join(', ')}. Abra a skill antes de seguir o que ela pede.`)
  return lines.join('\n').slice(0, 4 * 1024)
}

/**
 * The routine section of a turn. It gives the model an anchor for relative phrasing and states
 * the one rule that matters: a suggestion is a card a person still has to confirm. Inside a
 * scheduled run it says the opposite — that this turn may not suggest anything at all — so a
 * routine cannot quietly breed more routines.
 */
export function routinesBlock(routines: NonNullable<TurnSnapshot['routines']>): string {
  const lines = ['## Rotinas e horários']
  lines.push(
    routines.timeZone
      ? `Agora são ${routines.nowLocal} no fuso da pessoa (${routines.timeZone}).`
      : 'O fuso horário da pessoa não é conhecido. Se ela falar de horários, pergunte o fuso antes de sugerir qualquer rotina.'
  )
  if (!routines.canPropose) {
    lines.push('Esta execução não pode criar, alterar nem ativar rotinas. Se algo deveria virar rotina, escreva isso no seu resultado para a pessoa decidir depois.')
    return lines.join('\n')
  }
  lines.push(
    'Se a pessoa pedir algo recorrente, use routine_propose para deixar um CARTÃO de sugestão.',
    'O cartão não agenda nada: a rotina só existe depois que a pessoa revisar e confirmar na tela. Nunca diga que já está agendada.',
    `Você pode deixar no máximo ${routines.proposalsRemaining} sugestão(ões) nesta conversa agora.`
  )
  if (routines.existing.length)
    lines.push('', 'Rotinas que já existem para este destino:', ...routines.existing.map((routine) => `- ${routine.name}: ${routine.schedule}`))
  return lines.join('\n').slice(0, 8 * 1024)
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
