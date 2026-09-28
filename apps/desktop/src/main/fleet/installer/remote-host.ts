import type { FleetInstallerErrorCode } from '../../../shared/fleet-installer'
import { lastLine } from './docker-host'
import { InstallerError } from './errors'
import { BOT_SERVER_REMOTE_DIR } from './project'
import type { RunOptions } from './runner'
import { remoteFailure, shellQuote, type SshSession } from './ssh'

/**
 * VPS-only steps. Each is a fixed script sent on standard input to `sh -s -- <arguments>`; its first line names it, so
 * logs and test servers can tell them apart. Arguments are quoted; nothing is interpolated into a script.
 */
type RemoteShell = Pick<SshSession, 'exec'>

const asRoot = 'as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }'

const PROBE_SCRIPT = `# maestrly-bot-server:probe
set -u
${asRoot}
dir=$1
if [ -r /etc/os-release ]; then . /etc/os-release; fi
printf 'os_id=%s\\n' "\${ID:-}"
printf 'os_version=%s\\n' "\${VERSION_ID:-}"
printf 'os_name=%s\\n' "\${PRETTY_NAME:-}"
printf 'arch=%s\\n' "$(uname -m)"
printf 'memory_kb=%s\\n' "$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
printf 'disk_free_kb=%s\\n' "$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')"
printf 'hostname=%s\\n' "$(hostname 2>/dev/null || uname -n)"
if [ "$(id -u)" = 0 ]; then echo root=1; else echo root=0; fi
if sudo -n true >/dev/null 2>&1; then echo sudo=1; else echo sudo=0; fi
if command -v docker >/dev/null 2>&1; then echo docker=1; else echo docker=0; fi
if as_root docker compose version >/dev/null 2>&1; then echo compose=1; else echo compose=0; fi
if as_root test -f "$dir/.env" 2>/dev/null; then
  printf 'existing_env=%s\\n' "$(as_root cat "$dir/.env" | base64 | tr -d '\\n')"
fi
`

const INSTALL_DOCKER_SCRIPT = `# maestrly-bot-server:install-docker
set -eu
${asRoot}
if ! command -v curl >/dev/null 2>&1; then
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update -q
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q curl ca-certificates
fi
installer=$(mktemp)
curl -fsSL https://get.docker.com -o "$installer"
as_root sh "$installer"
rm -f "$installer"
as_root systemctl enable --now docker
as_root docker compose version
`

const AUTHORIZE_KEY_SCRIPT = `# maestrly-bot-server:authorize-key
set -eu
umask 077
key=$1
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
file="$HOME/.ssh/authorized_keys"
touch "$file"
chmod 600 "$file"
if grep -qxF "$key" "$file"; then exit 0; fi
if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then printf '\\n' >> "$file"; fi
printf '%s\\n' "$key" >> "$file"
`

const REVOKE_KEY_SCRIPT = `# maestrly-bot-server:revoke-key
set -eu
umask 077
tag=" $1"
file="$HOME/.ssh/authorized_keys"
[ -f "$file" ] || exit 0
temporary="$file.maestrly.$$"
awk -v tag="$tag" '{ n = length($0); m = length(tag); if (n >= m && substr($0, n - m + 1) == tag) next; print }' "$file" > "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$file"
`

const REMOVE_PROJECT_SCRIPT = `# maestrly-bot-server:remove-project
set -eu
${asRoot}
as_root rm -rf -- "$1"
`

export interface RemoteProbe {
  osId: string
  osVersion: string
  osName: string
  arch: string
  memoryBytes: number | null
  diskFreeBytes: number | null
  hostname: string
  root: boolean
  sudo: boolean
  docker: boolean
  compose: boolean
  /** The `.env` of a bot server Maestrly already installed there, or null. */
  existingEnv: string | null
}

function script(session: RemoteShell, source: string, args: string[], options?: RunOptions) {
  return session.exec(`sh -s -- ${args.map(shellQuote).join(' ')}`.trimEnd(), { ...options, input: source })
}

export function parseProbe(output: string): RemoteProbe {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim())
  }
  const kilobytes = (key: string) => {
    const value = Number(values.get(key))
    return Number.isFinite(value) && value > 0 ? value * 1024 : null
  }
  const encodedEnv = values.get('existing_env')
  return {
    osId: values.get('os_id') ?? '',
    osVersion: values.get('os_version') ?? '',
    osName: values.get('os_name') ?? '',
    arch: values.get('arch') ?? '',
    memoryBytes: kilobytes('memory_kb'),
    diskFreeBytes: kilobytes('disk_free_kb'),
    hostname: values.get('hostname') ?? '',
    root: values.get('root') === '1',
    sudo: values.get('sudo') === '1',
    docker: values.get('docker') === '1',
    compose: values.get('compose') === '1',
    existingEnv: encodedEnv ? Buffer.from(encodedEnv, 'base64').toString('utf8') : null,
  }
}

export async function probeRemote(session: RemoteShell, options?: RunOptions): Promise<RemoteProbe> {
  const result = await script(session, PROBE_SCRIPT, [BOT_SERVER_REMOTE_DIR], options)
  if (result.code !== 0) throw remoteFailure(result)
  return parseProbe(result.stdout)
}

function atLeast(version: string, major: number, minor = 0): boolean {
  const match = /^(\d+)(?:\.(\d+))?/.exec(version)
  if (!match) return false
  const [found, foundMinor] = [Number(match[1]), Number(match[2] ?? 0)]
  return found > major || (found === major && foundMinor >= minor)
}

/** Why Maestrly cannot install on this server, or null: Ubuntu 22.04+ or Debian 12+, x86_64 or arm64, root or sudo. */
export function remoteSupport(probe: RemoteProbe): FleetInstallerErrorCode | null {
  const supported =
    (probe.osId === 'ubuntu' && atLeast(probe.osVersion, 22, 4)) ||
    (probe.osId === 'debian' && atLeast(probe.osVersion, 12))
  if (!supported) return 'os-unsupported'
  if (!['x86_64', 'amd64', 'aarch64', 'arm64'].includes(probe.arch)) return 'arch-unsupported'
  if (!probe.root && !probe.sudo) return 'ssh-sudo'
  return null
}

/** Installs Docker Engine and its Compose plugin with Docker's convenience script. */
export async function installDocker(session: RemoteShell, options?: RunOptions): Promise<void> {
  const result = await script(session, INSTALL_DOCKER_SCRIPT, [], { timeoutMs: 15 * 60_000, ...options })
  if (result.code !== 0) throw new InstallerError('docker-install-failed', lastLine(result.stderr, result.stdout))
}

export async function authorizeKey(session: RemoteShell, publicKey: string): Promise<void> {
  const result = await script(session, AUTHORIZE_KEY_SCRIPT, [publicKey.trim()])
  if (result.code !== 0) throw remoteFailure(result)
}

/** Removes Maestrly's key, found by the tag that ends its line, and nothing else. */
export async function revokeKey(session: RemoteShell, keyTag: string, options?: RunOptions): Promise<void> {
  const result = await script(session, REVOKE_KEY_SCRIPT, [keyTag], options)
  if (result.code !== 0) throw remoteFailure(result)
}

export async function removeRemoteProject(session: RemoteShell): Promise<void> {
  const result = await script(session, REMOVE_PROJECT_SCRIPT, [BOT_SERVER_REMOTE_DIR])
  if (result.code !== 0) throw remoteFailure(result)
}
