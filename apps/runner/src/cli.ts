#!/usr/bin/env node
import { chmod, stat } from 'node:fs/promises'
import os from 'node:os'
import { MaestrlyClient } from '@maestrly/client-sdk'
import { ContainerSandbox, inspectRepositories, RuntimeCatalog, ContainerCommandRunner } from '@maestrly/runner-core'
import { configFile, readConfig, writeConfig } from './config.js'
import { runRunner } from './main.js'
import { enroll, RunnerHttpClient } from './server-client.js'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function enrollCommand() {
  const serverUrl = option('url')
  const organizationId = option('organization')
  const token = option('token')
  if (!serverUrl || !organizationId || !token) throw new Error('enroll requires --url, --organization and --token.')
  const name = option('name') ?? os.hostname()
  const maxConcurrency = Number(option('concurrency') ?? 1)
  const metadata = await new MaestrlyClient({ baseUrl: serverUrl }).metadata()
  const identity = await enroll({ serverUrl, organizationId, token, name, maxConcurrency })
  await writeConfig({
    serverUrl: metadata.canonicalUrl,
    organizationId,
    ...identity,
    name,
    maxConcurrency,
    isolationMode: 'native-sandbox',
    containerImage: 'maestrly/runner-executor:local',
    repositories: [],
  })
  process.stdout.write(`Runner ${identity.runnerId} enrolled.\n`)
}

async function doctorCommand() {
  const file = configFile()
  const config = await readConfig(file)
  const mode = (await stat(file)).mode & 0o777
  if (process.platform !== 'win32' && mode !== 0o600) {
    await chmod(file, 0o600)
    throw new Error('Runner config permissions were repaired to 0600; run doctor again.')
  }
  const metadata = await new MaestrlyClient({ baseUrl: config.serverUrl }).metadata()
  const status = await new RunnerHttpClient(config).status()
  const container =
    config.isolationMode === 'container'
      ? await new ContainerSandbox('docker', config.containerImage).doctor()
      : { available: true, detail: 'Provider-native fail-closed sandboxes selected' }
  process.stdout.write(
    `${JSON.stringify({ protocol: metadata.protocolVersions,
      automation:await new RuntimeCatalog({codexExecutable:config.codexExecutable,environment:{...(process.env.OPENAI_API_KEY?{OPENAI_API_KEY:process.env.OPENAI_API_KEY}:{}),...(process.env.ANTHROPIC_API_KEY?{ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY}:{})},preCommandsAvailable:()=>new ContainerCommandRunner(config.containerImage).available()}).read(true), status, repositories: await inspectRepositories(config.repositories), storage: 'ok', isolation: container }, null, 2)}\n`
  )
  if (!container.available) process.exitCode = 1
}

async function main() {
  const command = process.argv[2]
  if (command === 'repository') {
    const config = await readConfig()
    const bindingId = option('binding')
    const localPath = option('path')
    if (!bindingId || !localPath) throw new Error('repository requires --binding and --path.')
    const candidate = { bindingId, localPath: (await import('node:path')).resolve(localPath) }
    const [status] = await inspectRepositories([candidate])
    if (!status?.available) throw new Error(status?.error ?? 'Repository is unavailable.')
    const branch = option('branch')
    if (branch && !status.branches.includes(branch)) throw new Error('The requested branch does not exist locally.')
    config.repositories = [...config.repositories.filter((r) => r.bindingId !== bindingId), candidate]
    await writeConfig(config)
    process.stdout.write('Repository approved. Restart the runner to apply the configuration.\n')
    return
  }
  if(command === 'configure') {
    const config=await readConfig()
    if(option('command-image'))config.containerImage=option('command-image')!
    if(option('codex-path'))config.codexExecutable=option('codex-path')
    await writeConfig(config)
    process.stdout.write('Runner configuration saved. Restart the runner to publish updated capabilities.\n')
    return
  }
  if (command === 'enroll') return enrollCommand()
  if (command === 'doctor') return doctorCommand()
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(await new RunnerHttpClient(await readConfig()).status(), null, 2)}\n`)
    return
  }
  if (command === 'revoke') {
    await new RunnerHttpClient(await readConfig()).revoke()
    process.stdout.write('Runner credential revoked.\n')
    return
  }
  if (command === 'run') {
    const abort = new AbortController()
    process.once('SIGINT', () => abort.abort())
    process.once('SIGTERM', () => abort.abort())
    await runRunner(abort.signal)
    return
  }
  throw new Error('Usage: maestrly-runner <enroll|configure|repository|doctor|run|status|revoke>')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
