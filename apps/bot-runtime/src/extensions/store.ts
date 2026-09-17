import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { skillFilePathSchema, type ExtensionsApply } from '@maestrly/host-protocol'
import { MCP_SERVER_NAME } from '../providers/codex/configuration.js'
import { runtimeError } from '../turns/service.js'

/** A Codex `mcp_servers.<name>` entry, as written to the thread configuration. */
export type CodexMcpServer =
  | { command: string; args: string[]; env: Record<string, string> }
  | { url: string; http_headers?: Record<string, string> }

/**
 * What the Host delivered for this bot: MCP servers and skills. Skills are files Codex reads
 * from `$CODEX_HOME/skills`, so they live on disk; the MCP configuration — with the secret
 * values of its environment — stays in memory only and reaches Codex inside each thread
 * configuration. A runtime restart therefore starts empty, and the Host sends everything again
 * on the next session, which is exactly when it would anyway.
 */
export class ExtensionsStore {
  private servers = new Map<string, CodexMcpServer>()
  private installed: string[] = []
  private revision?: number
  constructor(private readonly codexHome: string) {}
  private get skillsRoot() {
    return join(this.codexHome, 'skills')
  }
  /** Names of the configured servers: the elicitation handler decides from this list. */
  get names(): string[] {
    return [...this.servers.keys()]
  }
  get skills(): string[] {
    return [...this.installed]
  }
  get applied(): number | undefined {
    return this.revision
  }
  /** Forgets everything on disk from a previous run; the Host will deliver the current set again. */
  async reset() {
    this.servers.clear()
    this.installed = []
    this.revision = undefined
    await rm(this.skillsRoot, { recursive: true, force: true })
  }
  async apply(payload: ExtensionsApply): Promise<{ applied: number }> {
    const servers = new Map<string, CodexMcpServer>()
    for (const server of payload.mcpServers) {
      // The bot's own tool server keeps its name and its authority: a person cannot shadow it.
      if (server.name === MCP_SERVER_NAME) throw runtimeError('EXTENSIONS_INVALID', `The name ${MCP_SERVER_NAME} is reserved`)
      if (!server.enabled) continue
      servers.set(server.name, codexServer(server))
    }
    await rm(this.skillsRoot, { recursive: true, force: true })
    for (const skill of payload.skills) {
      const directory = join(this.skillsRoot, skill.name)
      for (const file of skill.files) {
        // The Host already validated these paths; a guest still refuses to write outside the skill.
        const relative = skillFilePathSchema.parse(file.path)
        const target = join(directory, relative)
        await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
        await writeFile(target, Buffer.from(file.dataBase64, 'base64'), { mode: 0o600 })
      }
    }
    this.servers = servers
    this.installed = payload.skills.map((skill) => skill.name)
    this.revision = payload.revision
    return { applied: payload.revision }
  }
  /** The `mcp_servers` fragment for the thread configuration. */
  codexServers(): Record<string, CodexMcpServer> {
    return Object.fromEntries(this.servers)
  }
}

function codexServer(server: ExtensionsApply['mcpServers'][number]): CodexMcpServer {
  if (server.transport === 'stdio') return { command: server.command ?? '', args: server.args, env: server.env }
  // An http server has no process to inherit variables: a secret reaches it through a header,
  // written as `${KEY}` and filled here so the stored configuration never contains the value.
  const headers = Object.fromEntries(
    Object.entries(server.headers ?? {}).map(([name, value]) => [name, value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, key: string) => server.env[key] ?? match)])
  )
  return { url: server.url ?? '', ...(Object.keys(headers).length ? { http_headers: headers } : {}) }
}
