import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import os from 'node:os'
import type { ExecutionContext, ExecutionHandle, ExecutionOutcome, ExecutorAdapter, ExecutorCapabilities } from '../executor.js'

export interface ClaudeAgentExecutorOptions {
  executable?:string
  queryFactory?: typeof query
  environment?: Record<string, string>
  maxTurns?: number
}

function promptFor(context: ExecutionContext): string {
  if(context.envelope.snapshot.renderedPrompt)return context.envelope.snapshot.renderedPrompt
  return `${context.envelope.snapshot.title}\n\n${context.envelope.snapshot.description}\n\nAcceptance criteria:\n${context.envelope.snapshot.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`
}

function outcomeFor(result: SDKResultMessage | undefined): ExecutionOutcome {
  if (!result) return { state: 'failed', failure: 'Claude Agent ended without a result event.' }
  if (result.subtype === 'success' && !result.is_error) {
    return { state: 'succeeded', summary: result.result, estimatedCostUsd: result.total_cost_usd }
  }
  const failure = result.subtype === 'success' ? result.result : result.errors.join('\n')
  return { state: 'failed', failure: failure || `Claude Agent stopped with ${result.subtype}.`, estimatedCostUsd: result.total_cost_usd }
}

export class ClaudeAgentExecutor implements ExecutorAdapter {
  constructor(private readonly options: ClaudeAgentExecutorOptions = {}) {}

  async capabilities(): Promise<ExecutorCapabilities> {
    return { executor: 'claude-agent', capabilities: [{ name: 'executor:claude-agent', version: '0.3.263', attributes: {} }, { name: 'delivery:patch', attributes: {} }] }
  }

  async start(context: ExecutionContext): Promise<ExecutionHandle> {
    const apiKey = context.environment.environment.ANTHROPIC_API_KEY ?? this.options.environment?.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for the shared Claude Agent executor.')
    const abortController = new AbortController()
    const session = (this.options.queryFactory ?? query)({
      prompt: promptFor(context),
      options: {
        abortController,
        pathToClaudeCodeExecutable:this.options.executable,
        cwd: context.environment.workspacePath,
        model: context.envelope.snapshot.model,
        effort: context.envelope.snapshot.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
        maxTurns: this.options.maxTurns ?? 100,
        permissionMode: context.readOnly?'dontAsk':'acceptEdits',
        settings:{fastMode:context.envelope.snapshot.fastMode===true,fastModePerSessionOptIn:true},
        settingSources:[],strictMcpConfig:true,mcpServers:{},agents:{},skills:[],plugins:[],
        tools: context.readOnly?['Read','Glob','Grep']:['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        allowedTools: context.readOnly?['Read','Glob','Grep']:['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        persistSession: false,
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          filesystem: {
            allowWrite: context.readOnly?[]:[context.environment.workspacePath],
            denyRead: [os.homedir()],
            denyWrite: [os.homedir()],
          },
          network: {
            allowedDomains: ['api.anthropic.com'],
            strictAllowlist: true,
            allowUnixSockets: [],
            allowLocalBinding: false,
          },
        },
        env: {
          ...Object.fromEntries(Object.keys(process.env).map(key=>[key,undefined])),
          PATH: process.env.PATH,
          LANG: process.env.LANG ?? 'C.UTF-8',
          ANTHROPIC_API_KEY: apiKey,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'maestrly-runner/0.1.0',
          ...this.options.environment,
          ...context.environment.environment,
        },
      },
    })
    let cancelled = false
    const done = (async (): Promise<ExecutionOutcome> => {
      let result: SDKResultMessage | undefined
      try {
        for await (const message of session) {
          if (message.type === 'result') result = message
          await context.emit({ type: `claude.${message.type}`, data: JSON.parse(JSON.stringify(message)) as Record<string, unknown> })
        }
        return cancelled ? { state: 'cancelled', summary: 'Claude Agent stopped.' } : outcomeFor(result)
      } catch (error) {
        if (cancelled || abortController.signal.aborted) return { state: 'cancelled', summary: 'Claude Agent stopped.' }
        return { state: 'failed', failure: error instanceof Error ? error.message : String(error) }
      } finally {
        session.close()
      }
    })()
    return {
      done,
      async cancel() {
        if (!abortController.signal.aborted) abortController.abort('Execution cancelled by Maestrly.')
        cancelled = true
        session.close()
        await done
      },
    }
  }
}
