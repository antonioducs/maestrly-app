import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { InstallOutcome, LocalHostStatus } from '../shared/types'
import { inspectLocalHost } from './local-transport'
const execute = promisify(execFile)
/**
 * "Neste Mac": the Host is installed only from a verified, root-owned staged package using the
 * fixed installer, authorized through the macOS administrator prompt. The app never collects or
 * stores the password and never builds commands from renderer input.
 */
export const STAGED_PACKAGE = '/private/var/tmp/maestrly-host-package'
export interface InstallationDeps {
  inspect?: () => Promise<LocalHostStatus>
  stagedManifest?: () => Promise<{ sha256: string; architecture: string; minimumMacOS?: string } | null>
  authorize?: (script: string) => Promise<{ code: number; stderr: string }>
  platform?: NodeJS.Platform
  arch?: string
}
export async function stagedManifest(): Promise<{ sha256: string; architecture: string; minimumMacOS?: string } | null> {
  try {
    const dir = await lstat(STAGED_PACKAGE)
    const manifestPath = join(STAGED_PACKAGE, 'manifest.json')
    const manifest = await lstat(manifestPath)
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 0 || !manifest.isFile() || manifest.uid !== 0) return null
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (typeof parsed.architecture !== 'string') return null
    const { createHash } = await import('node:crypto')
    const sha256 = createHash('sha256').update(await readFile(manifestPath)).digest('hex')
    return { sha256, architecture: parsed.architecture, minimumMacOS: parsed.minimumMacOS }
  } catch {
    return null
  }
}
/** osascript prompts the administrator; the script text is a fixed, quoted invocation of the fixed installer. */
export async function authorizeAdministrator(script: string) {
  try {
    const { stderr } = await execute('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(script)} with administrator privileges`], { timeout: 600_000, maxBuffer: 1024 * 1024 })
    return { code: 0, stderr: String(stderr) }
  } catch (error) {
    const failure = error as { code?: number; stderr?: string; message?: string }
    return { code: typeof failure.code === 'number' ? failure.code : 1, stderr: String(failure.stderr ?? failure.message ?? '') }
  }
}
export async function installLocalHost(input: { namespace: string; identity: string; caps: { cpus: number; memoryMiB: number; diskGiB: number }; operator: string | null }, deps: InstallationDeps = {}): Promise<InstallOutcome> {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  if (platform !== 'darwin') return { status: 'blocked', message: 'A instalação do Host só é possível no macOS. Escolha outro computador.' }
  const current = await (deps.inspect ?? inspectLocalHost)()
  if (current.state === 'installed') return { status: 'installed', message: 'O Host já está instalado neste Mac.' }
  if (current.state === 'untrusted') return { status: 'blocked', message: `${current.reason}. Peça ao administrador para revisar /Library/MaestrlyHost.` }
  const manifest = await (deps.stagedManifest ?? stagedManifest)()
  if (!manifest) return { status: 'blocked', message: 'Nenhum pacote verificado do Host está preparado neste Mac. Transfira o pacote assinado antes de instalar ou escolha outro computador.' }
  if (manifest.architecture !== arch) return { status: 'blocked', message: `O pacote preparado é para ${manifest.architecture}, mas este Mac é ${arch}.` }
  if (!/^lab-[a-z0-9][a-z0-9-]{0,39}$/.test(input.namespace) || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.identity))
    return { status: 'blocked', message: 'Identificação do Mac ou namespace inválidos.' }
  for (const [key, max] of Object.entries({ cpus: 128, memoryMiB: 1_048_576, diskGiB: 16_384 }) as ['cpus' | 'memoryMiB' | 'diskGiB', number][])
    if (!Number.isSafeInteger(input.caps[key]) || input.caps[key] < 1 || input.caps[key] > max) return { status: 'blocked', message: 'Cotas inválidas.' }
  if (input.operator !== null && !/^[a-z][a-z0-9_-]{0,30}$/.test(input.operator)) return { status: 'blocked', message: 'Operador inválido.' }
  const script = [
    '/bin/sh',
    `${STAGED_PACKAGE}/install/install.sh`,
    '--authorize-install',
    input.namespace,
    input.identity,
    String(input.caps.cpus),
    String(input.caps.memoryMiB),
    String(input.caps.diskGiB),
    manifest.sha256,
    input.operator ?? '--no-operator',
  ].join(' ')
  const result = await (deps.authorize ?? authorizeAdministrator)(script)
  if (result.code === 0) return { status: 'installed', message: 'Host instalado. Reabra a conexão para continuar.' }
  if (/User canceled|-128/.test(result.stderr)) return { status: 'cancelled', message: 'Instalação cancelada.' }
  return { status: 'failed', message: `O instalador recusou a instalação: ${result.stderr.replace(/\s+/g, ' ').slice(-300)}` }
}
