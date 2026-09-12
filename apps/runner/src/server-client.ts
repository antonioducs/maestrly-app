import { inspectRepositories, RuntimeCatalog, ContainerCommandRunner } from '@maestrly/runner-core'
import { HttpTransport } from '@maestrly/client-sdk'
import type { RunnerClaim, RunnerServer } from '@maestrly/runner-core'
import type { DeliveryArtifact, ExecutionArtifact } from '@maestrly/runner-core'
import type { RunnerConfig } from './config.js'

export class RunnerHttpClient implements RunnerServer {
  readonly transport: HttpTransport
  private readonly catalog:Pick<RuntimeCatalog,'read'>
  constructor(private readonly config: RunnerConfig,catalog?:Pick<RuntimeCatalog,'read'>) {
    this.catalog=catalog??new RuntimeCatalog({
      codexExecutable:config.codexExecutable,
      environment:{...(process.env.OPENAI_API_KEY?{OPENAI_API_KEY:process.env.OPENAI_API_KEY}:{}),...(process.env.ANTHROPIC_API_KEY?{ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY}:{})},
      preCommandsAvailable:()=>new ContainerCommandRunner(config.containerImage).available(),
    })
    this.transport = new HttpTransport({ baseUrl: config.serverUrl })
  }

  private headers() {
    return {
      authorization: `Runner ${this.config.credential}`,
      'x-maestrly-organization-id': this.config.organizationId,
      'x-maestrly-runner-id': this.config.runnerId,
      'x-maestrly-protocol-version': '1.0',
    }
  }

  async claim(): Promise<RunnerClaim | null> {
    return this.transport.request('POST', '/api/v1/runners/claim', {
      headers: this.headers(),
      body: { repositories: await inspectRepositories(this.config.repositories),automationCapabilities:await this.catalog.read() },
    })
  }

  renew(runId: string, leaseId: string) {
    return this.transport.request<{ leaseExpiresAt: string; cancellationRequested: boolean }>(
      'POST',
      `/api/v1/runners/runs/${runId}/lease`,
      {
        headers: this.headers(),
        body: { leaseId },
      }
    )
  }

  event(
    runId: string,
    leaseId: string,
    event: { eventId: string; type: string; data: Record<string, unknown> }
  ): Promise<void> {
    return this.transport.request('POST', `/api/v1/runners/runs/${runId}/events`, {
      headers: this.headers(),
      body: { leaseId, ...event },
    })
  }

  complete(runId: string, leaseId: string, completion: Record<string, unknown>): Promise<void> {
    return this.transport.request('POST', `/api/v1/runners/runs/${runId}/complete`, {
      headers: this.headers(),
      body: { leaseId, completion },
    })
  }

  uploadArtifact(runId: string, leaseId: string, artifact: ExecutionArtifact): Promise<DeliveryArtifact> {
    return this.transport.request('POST', `/api/v1/runners/runs/${runId}/artifacts`, {
      headers: this.headers(),
      body: {
        leaseId,
        kind: artifact.kind,
        name: artifact.name,
        contentType: artifact.contentType,
        contentBase64: Buffer.from(artifact.bytes).toString('base64'),
      },
    })
  }

  async reconcile(run: { runId: string; leaseId: string }): Promise<'active' | 'terminal' | 'unknown'> {
    const response = await this.transport.request<{ state: string }>(
      'GET',
      `/api/v1/runners/runs/${run.runId}/status?leaseId=${encodeURIComponent(run.leaseId)}`,
      { headers: this.headers() }
    )
    return ['claimed', 'running', 'cancelling'].includes(response.state) ? 'active' : 'terminal'
  }

  status() {
    return this.transport.request<{ status: string; activeRuns: number }>('GET', '/api/v1/runners/status', {
      headers: this.headers(),
    })
  }

  revoke(): Promise<void> {
    return this.transport.request('POST', '/api/v1/runners/self/revoke', { headers: this.headers(), body: {} })
  }
}

export async function enroll(input: {
  serverUrl: string
  organizationId: string
  token: string
  name: string
  maxConcurrency: number
}) {
  const transport = new HttpTransport({ baseUrl: input.serverUrl })
  return transport.request<{ runnerId: string; credential: string }>('POST', '/api/v1/runners/enroll', {
    body: {
      organizationId: input.organizationId,
      token: input.token,
      name: input.name,
      protocolVersion: '1.0',
      capabilities: [
        { name: 'executor:codex', version: '0.153' },
        { name: 'executor:claude-agent', version: '0.3.258' },
        { name: 'delivery:patch' },
      ],
      maxConcurrency: input.maxConcurrency,
    },
    headers: { 'x-maestrly-protocol-version': '1.0' },
  })
}
