import { randomUUID } from 'node:crypto'
import type { TeamArtifact, TeamArtifactGrant, TeamRun, TeamTask } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { TeamArtifacts, deliveryPath } from './artifacts.js'
import { TeamRepository, now } from './repository.js'

/**
 * Turns an authorization into delivered copies. A grant is created before anything is
 * written and re-checked immediately before each delivery, so removing a member or
 * revoking a file blocks work that was already queued.
 */
export class TeamSharing {
  constructor(
    private readonly teams: TeamRepository,
    private readonly artifacts: TeamArtifacts
  ) {}

  /** Records intent for every artifact a task is allowed to read, before any transfer. */
  authorize(run: TeamRun, task: TeamTask, artifactIds: readonly string[]): TeamArtifactGrant[] {
    return this.teams.transaction(() =>
      artifactIds.map((artifactId) => {
        const artifact = this.teams.artifact(artifactId)
        if (artifact.teamId !== run.teamId) throw new HostError('TEAM_GRANT_REVOKED', 'Este arquivo não pertence a esta equipe')
        if (artifact.state !== 'available') throw new HostError('TEAM_GRANT_REVOKED', 'Este arquivo não está mais disponível')
        const existing = this.teams.grant(artifactId, task.assigneeBotId, run.id)
        if (existing && existing.state !== 'revoked') return existing
        const grant: TeamArtifactGrant = {
          id: randomUUID(),
          artifactId,
          teamId: run.teamId,
          botId: task.assigneeBotId,
          runId: run.id,
          taskId: task.id,
          path: deliveryPath(artifact, run.id),
          state: 'pending',
          digest: artifact.digest,
          createdAt: now(),
          updatedAt: now(),
        }
        this.teams.saveGrant(grant)
        return grant
      })
    )
  }

  /**
   * Delivers everything a task still needs. Revalidation happens per grant so a revocation
   * in the middle of a transfer stops the next file instead of finishing the batch.
   */
  async stage(run: TeamRun, task: TeamTask): Promise<{ delivered: number; failed?: { artifactId: string; code: string } }> {
    const pending = this.teams
      .grantsOfRun(run.id)
      .filter((grant) => grant.botId === task.assigneeBotId && grant.state === 'pending')
    let delivered = 0
    for (const grant of pending) {
      const current = this.teams.grant(grant.artifactId, grant.botId, grant.runId)
      if (!current || current.state === 'revoked') return { delivered, failed: { artifactId: grant.artifactId, code: 'TEAM_GRANT_REVOKED' } }
      if (current.state === 'delivered') continue
      try {
        await this.artifacts.deliver(current)
        delivered++
      } catch (error) {
        const code = error instanceof HostError ? error.code : 'TRANSFER_FAILED'
        return { delivered, failed: { artifactId: grant.artifactId, code } }
      }
    }
    return { delivered }
  }

  /** Artifacts a task may read: the run's authorized resources plus its declared inputs. */
  inputsFor(run: TeamRun, task: TeamTask): string[] {
    const fromRun = run.resources.map((resource) => resource.artifactId)
    const fromDependencies = task.useDependencyOutputs
      ? task.dependsOn.flatMap((id) => this.teams.task(id).result?.artifacts.map((artifact) => artifact.artifactId) ?? [])
      : []
    return [...new Set([...fromRun, ...task.inputArtifactIds, ...fromDependencies])]
  }

  /** Publishing is a flow authorization, not proof that the content holds no private data. */
  publishedBy(artifact: TeamArtifact) {
    return artifact.origin.kind === 'bot' ? artifact.origin.botId : undefined
  }
}
