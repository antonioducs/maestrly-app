import path from 'node:path'
import {
  ClaudeAgentExecutor,
  CodexExecutor,
  ContainerSandbox,
  ContainerCommandRunner,
  CredentialBroker,
  RunnerEngine,
  RunnerJournal,
  WorkspaceManager,
  type ExecutorAdapter,
} from '@maestrly/runner-core'
import { configFile, readConfig } from './config.js'
import { RunnerHttpClient } from './server-client.js'

export async function runRunner(signal?: AbortSignal): Promise<void> {
  const config = await readConfig()
  const server = new RunnerHttpClient(config)
  const broker = new CredentialBroker({
    ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
  })
  const codexEnvironment = (() => {
    try {
      return broker.forProvider('codex')
    } catch {
      return {}
    }
  })()
  const claudeEnvironment = (() => {
    try {
      return broker.forProvider('claude-agent')
    } catch {
      return {}
    }
  })()
  const executors = new Map<string, ExecutorAdapter>([
    ['codex', new CodexExecutor({ executable:config.codexExecutable,extraEnvironment: codexEnvironment })],
    ['claude-agent', new ClaudeAgentExecutor({ environment: claudeEnvironment })],
  ])
  const workspace = new WorkspaceManager({
    repositories: config.repositories,
    isolated: true,
  })
  if (config.isolationMode === 'container') {
    const doctor = await new ContainerSandbox('docker', config.containerImage).doctor()
    if (!doctor.available) throw new Error(`Container isolation is unavailable: ${doctor.detail}`)
  }
  const journal = new RunnerJournal(path.join(path.dirname(configFile()), 'journal.json'))
  const engine = new RunnerEngine(server, executors, workspace, journal,{commandRunner:new ContainerCommandRunner(config.containerImage)})
  await engine.recover()
  const stop = () => {
    void engine.stop()
  }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    while (!signal?.aborted) {
      const worked = await engine.runOnce()
      if (!worked) await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  } finally {
    signal?.removeEventListener('abort', stop)
    await engine.stop()
  }
}
