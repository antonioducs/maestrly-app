import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AntigravitySubscriptionManager,
  type AntigravityManagerOptions,
} from '../../src/main/chat/antigravity-subscription/manager'
import { buildAntigravityProcessEnv } from '../../src/main/chat/antigravity-subscription/paths'

export const FAKE_ACP_AGENT = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))

export interface FakeAntigravity {
  readonly userData: string
  readonly logFile: string
  /** Mutable per-test agent environment (`FAKE_ACP_SCENARIO`, `FAKE_ACP_PROJECT`, ...). */
  readonly env: Record<string, string>
  runtimeStarts: number
  manager(options?: Partial<AntigravityManagerOptions>): AntigravitySubscriptionManager
  log(): Array<Record<string, unknown>>
  requests(method: string): Array<Record<string, unknown>>
  cleanup(): Promise<void>
}

/** Managers backed by `test/fixtures/fake-acp-agent.mjs`, isolated in a temporary userData directory. */
export function createFakeAntigravity(): FakeAntigravity {
  const userData = mkdtempSync(path.join(tmpdir(), 'agy-fake-'))
  const logFile = path.join(userData, 'agent.log')
  const managers: AntigravitySubscriptionManager[] = []
  const fake: FakeAntigravity = {
    userData,
    logFile,
    env: {},
    runtimeStarts: 0,
    manager(options = {}) {
      const manager = new AntigravitySubscriptionManager({
        accountId: null,
        userDataPath: () => userData,
        resolveRuntime: async () => {
          fake.runtimeStarts++
          return { command: process.execPath, args: [FAKE_ACP_AGENT], release() {} }
        },
        processEnv: (root) => ({ ...buildAntigravityProcessEnv(root), FAKE_ACP_LOG: logFile, ...fake.env }),
        ...options,
      })
      managers.push(manager)
      return manager
    },
    log() {
      if (!existsSync(logFile)) return []
      return readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    },
    requests(method) {
      return fake.log().filter((entry) => entry.method === method)
    },
    async cleanup() {
      await Promise.all(managers.map((manager) => manager.dispose()))
      rmSync(userData, { recursive: true, force: true })
    },
  }
  return fake
}
