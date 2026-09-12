import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { query, type ModelInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ExecutorModel, RunnerAutomationCapabilities } from '@maestrly/protocol'
const exec = promisify(execFile)
export async function loadCodexModels(executable: string, home: string): Promise<Record<string, any>[]> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const result = await exec(executable, ['debug', 'models', '--bundled'], {
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, CODEX_HOME: home, LANG: 'C.UTF-8' },
  })
  const value = JSON.parse(result.stdout)
  if (!Array.isArray(value.models) || !value.models.length) throw new Error('Codex model catalog unavailable.')
  return value.models
}
export async function neutralizedCodexCatalog(executable: string, home: string, loader = loadCodexModels) {
  const models = await loader(executable, home)
  const file = path.join(home, 'maestrly-runtime-models.json')
  await writeFile(file, JSON.stringify({ models: models.map((model) => ({ ...model, multi_agent_version: null })) }), {
    mode: 0o600,
  })
  return file
}
export function codexModelCapabilities(models: Record<string, any>[], allowedIds: Set<string>): ExecutorModel[] {
  return models
    .filter((model) => model.supported_in_api && model.visibility !== 'hide' && allowedIds.has(model.slug))
    .map((model) => ({
      provider: 'codex',
      model: model.slug,
      label: model.display_name || model.slug,
      efforts: (model.supported_reasoning_levels ?? [])
        .map((entry: any) => entry.effort)
        .filter((effort: unknown) => typeof effort === 'string'),
      fastMode: (model.service_tiers ?? []).some((tier: any) => ['priority', 'fast'].includes(tier.id)),
      fastServiceTier:
        (model.service_tiers ?? []).find((tier: any) => tier.id === 'priority')?.id ??
        (model.service_tiers ?? []).find((tier: any) => tier.id === 'fast')?.id,
    }))
}
export function claudeModelCapabilities(models: ModelInfo[]): ExecutorModel[] {
  return models.map((model) => ({
    provider: 'claude-agent',
    model: model.resolvedModel ?? model.value,
    label: model.displayName,
    efforts: model.supportedEffortLevels ?? [],
    fastMode: model.supportsFastMode === true,
  }))
}
export interface CatalogOptions {
  loadCodexCatalog?: typeof loadCodexModels
  codexExecutable?: string
  claudeExecutable?:string
  environment?: Record<string, string>
  preCommandsAvailable?: () => Promise<boolean>
  fetch?: typeof globalThis.fetch
  claudeQuery?: typeof query
}
export class RuntimeCatalog {
  private cached?: { at: number; value: RunnerAutomationCapabilities }
  constructor(private readonly options: CatalogOptions = {}) {}
  async read(force = false): Promise<RunnerAutomationCapabilities> {
    if (!force && this.cached && Date.now() - this.cached.at < 300000) return this.cached.value
    const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-catalog-'))
    const env = this.options.environment ?? {}
    const models: ExecutorModel[] = [],
      issues: string[] = []
    try {
      if (env.OPENAI_API_KEY) {
        try {
          const response = await (this.options.fetch ?? fetch)('https://api.openai.com/v1/models', {
            headers: { authorization: 'Bearer ' + env.OPENAI_API_KEY },
            signal: AbortSignal.timeout(15000),
          })
          if (!response.ok) throw new Error('Model discovery failed.')
          const allowed = (await response.json()) as { data: Array<{ id: string }> }
          models.push(
            ...codexModelCapabilities(
              await (this.options.loadCodexCatalog ?? loadCodexModels)(
                this.options.codexExecutable ?? 'codex',
                path.join(root, 'codex')
              ),
              new Set(allowed.data.map((m) => m.id))
            )
          )
        } catch {
          issues.push('Codex catalog unavailable. Check the CLI and its API credential.')
        }
      } else issues.push('Codex API credential is not configured.')
      if (env.ANTHROPIC_API_KEY) {
        let release: () => void = () => {}
        const stopped = new Promise<void>((resolve) => {
          release = resolve
        })
        const source: AsyncIterable<SDKUserMessage> = {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await stopped
              return { done: true as const, value: undefined }
            },
          }),
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15000)
        let client: ReturnType<typeof query> | undefined
        try {
          client = (this.options.claudeQuery ?? query)({
            prompt: source,
            options: {
              cwd: root,
              pathToClaudeCodeExecutable:this.options.claudeExecutable,
              abortController: controller,
              settingSources: [],
              persistSession: false,
              tools: [],
              permissionMode: 'dontAsk',
              env: { PATH: process.env.PATH, HOME: root, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY },
            },
          })
          const result = await Promise.race([
            client.supportedModels(),
            new Promise<never>((_, reject) =>
              controller.signal.addEventListener('abort', () => reject(new Error('Catalog discovery timed out.')), {
                once: true,
              })
            ),
          ])
          models.push(...claudeModelCapabilities(result))
        } catch {
          issues.push('Claude catalog unavailable. Check the SDK and its API credential.')
        } finally {
          clearTimeout(timer)
          release()
          client?.close()
        }
      } else issues.push('Claude API credential is not configured.')
      const preCommands = (await this.options.preCommandsAvailable?.().catch(() => false)) ?? false
      const value = {
        version: 1 as const,
        models,
        maestro: models.length > 0,
        subagents: models.length > 0,
        preCommands,
        issues,
      }
      this.cached = { at: Date.now(), value }
      return value
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}
