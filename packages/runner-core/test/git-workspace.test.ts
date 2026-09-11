import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceManager, inspectRepositories } from '../src/workspace.js'
import { RunnerEngine, type RunnerServer } from '../src/engine.js'
import { RunnerJournal } from '../src/journal.js'
import type { ExecutionArtifact, ExecutorAdapter } from '../src/executor.js'
import type { ExecutionEnvelope } from '@maestrly/protocol'

describe('approved Git workspace delivery', () => {
  it('uses the snapshot branch, keeps the checkout unchanged and delivers an applicable patch with its base commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-git-fixture-')),
      repo = path.join(root, 'repo')
    const git = (args: string[], cwd = repo) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd, encoding: 'utf8' }
      ).trim()
    try {
      execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'ignore' })
      // Keep the patch fixture independent of the runner's global Windows Git settings.
      git(['config', 'core.autocrlf', 'false'])
      await writeFile(path.join(repo, 'file.txt'), 'main\n')
      git(['add', '.'])
      git(['commit', '-m', 'fixture'])
      git(['checkout', '-b', 'release'])
      await writeFile(path.join(repo, 'file.txt'), 'release\n')
      git(['commit', '-am', 'release fixture'])
      const expectedBase = git(['rev-parse', 'HEAD'])
      git(['checkout', 'main'])
      const manager = new WorkspaceManager({
        repositories: [{ bindingId: 'binding', localPath: repo }],
        isolated: true,
      })
      expect(await inspectRepositories([{ bindingId: 'binding', localPath: repo }])).toEqual([
        { bindingId: 'binding', available: true, branches: ['main', 'release'] },
      ])
      const envelope: ExecutionEnvelope = {
        protocolVersion: '1.0',
        organizationId: 'org',
        projectId: 'project',
        boardId: 'board',
        cardId: 'card',
        jobId: 'job',
        runId: 'run',
        attempt: 1,
        leaseId: 'lease',
        leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
        sourceEventId: 'event',
        cardVersion: 1,
        policyVersion: 1,
        executionProfileId: 'default',
        snapshot: {
          title: 'Edit',
          description: 'Test',
          acceptanceCriteria: [],
          taskType: 'code',
          provider: 'codex',
          model: 'fixture',
          repositoryBindingId: 'binding',
          repositoryBranch: 'release',
          delivery: { mode: 'patch', requireHumanApproval: true },
        },
      }
      const artifacts: ExecutionArtifact[] = [],
        completions: Record<string, unknown>[] = []
      const server: RunnerServer = {
        claim: async () => ({ envelope, executionToken: 'fixture' }),
        renew: async () => ({ leaseExpiresAt: envelope.leaseExpiresAt, cancellationRequested: false }),
        event: async () => {},
        complete: async (_r, _l, result) => {
          completions.push(result)
        },
        reconcile: async () => 'terminal',
        uploadArtifact: async (_r, _l, item) => {
          artifacts.push(item)
          return {
            kind: item.kind,
            name: item.name,
            contentType: item.contentType,
            sizeBytes: item.bytes.byteLength,
            digest: 'fixture',
            storageKey: item.name,
          }
        },
      }
      let clone = ''
      const adapter: ExecutorAdapter = {
        capabilities: async () => ({ executor: 'codex', capabilities: [] }),
        start: async (context) => {
          clone = context.environment.workspacePath
          expect(await readFile(path.join(clone, 'file.txt'), 'utf8')).toBe('release\n')
          expect(git(['remote'], clone)).toBe('')
          await writeFile(path.join(clone, 'file.txt'), 'changed\n')
          await writeFile(path.join(clone, 'new.txt'), 'new file\n')
          return { done: Promise.resolve({ state: 'succeeded', summary: 'Verified fixture' }), cancel: async () => {} }
        },
      }
      await new RunnerEngine(
        server,
        new Map([['codex', adapter]]),
        manager,
        new RunnerJournal(path.join(root, 'journal.json'))
      ).runOnce()
      expect(completions[0]?.state).toBe('succeeded')
      const evidence = JSON.parse(Buffer.from(artifacts.find((a) => a.name === 'git-base.json')!.bytes).toString())
      expect(evidence.baseCommit).toBe(expectedBase)
      const patch = path.join(root, 'delivery.patch')
      await writeFile(patch, artifacts.find((a) => a.kind === 'patch')!.bytes)
      expect(await readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('main\n')
      expect(git(['status', '--porcelain'])).toBe('')
      git(['checkout', 'release'])
      git(['apply', '--check', patch])
      git(['apply', patch])
      expect(await readFile(path.join(repo, 'new.txt'), 'utf8')).toBe('new file\n')
      await expect(access(clone)).rejects.toThrow()
      await expect(
        manager.prepare({ ...envelope, snapshot: { ...envelope.snapshot, repositoryBranch: 'missing' } })
      ).rejects.toThrow()
      await expect(
        manager.prepare({ ...envelope, snapshot: { ...envelope.snapshot, repositoryBindingId: 'unapproved' } })
      ).rejects.toThrow(/not approved/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
