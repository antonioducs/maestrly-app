import { spawn } from 'node:child_process'
import type { ExecutionArtifact } from '../executor.js'

async function output(cwd: string, args: string[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384) })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr || `git exited with ${code}`)))
  })
}

export async function createPatchDelivery(workspacePath: string): Promise<ExecutionArtifact> {
  return { kind: 'patch', name: 'changes.patch', contentType: 'text/x-diff', bytes: await output(workspacePath, ['diff', '--binary', '--no-ext-diff', 'HEAD']) }
}

export function assertPushAuthorized(input: { policyAllowsPush: boolean; deliveryCredential?: string }): void {
  if (!input.policyAllowsPush || !input.deliveryCredential) throw new Error('Push requires an explicit policy and delivery credential.')
}
