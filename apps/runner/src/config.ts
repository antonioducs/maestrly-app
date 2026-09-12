import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

const configSchema = z.object({
  serverUrl: z.string().url(),
  organizationId: z.string().min(1),
  runnerId: z.string().min(1),
  credential: z.string().min(32),
  name: z.string().min(1),
  codexExecutable:z.string().optional(),
  isolationMode: z.enum(['native-sandbox', 'container']).default('native-sandbox'),
  containerImage: z.string().min(1).default('maestrly/runner-executor:local'),
  maxConcurrency: z.number().int().positive().max(128).default(1),
  repositories: z.array(z.object({ bindingId: z.string().min(1), localPath: z.string().min(1) })).default([]),
})

export type RunnerConfig = z.infer<typeof configSchema>

export function configFile(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.MAESTRLY_RUNNER_CONFIG ?? path.join(os.homedir(), '.config', 'maestrly-runner', 'config.json')
}

export async function readConfig(file = configFile()): Promise<RunnerConfig> {
  return configSchema.parse(JSON.parse(await readFile(file, 'utf8')))
}

export async function writeConfig(value: RunnerConfig, file = configFile()): Promise<void> {
  const parsed = configSchema.parse(value)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
  if (process.platform !== 'win32') await chmod(file, 0o600)
}

export { configSchema }
