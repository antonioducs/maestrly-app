import { z } from 'zod'
import { revision } from './common.js'

// Egress policy: hostnames on 80/443 only. Blocklist entries also cover subdomains.
// Literal IPs and wildcards are rejected here;
// resolved addresses are validated again by the broker before every connection.
const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
export const HOST_NAME_MAX = 253
export function isExactHostname(value: string): boolean {
  if (value.length < 1 || value.length > HOST_NAME_MAX || value.endsWith('.')) return false
  const labels = value.split('.')
  if (labels.length < 2) return false
  if (!labels.every((part) => label.test(part))) return false
  if (/^\d+$/.test(labels.at(-1) as string)) return false
  return !value.includes('*')
}
export const hostnameSchema = z
  .string()
  .max(HOST_NAME_MAX)
  .transform((value) => value.toLowerCase())
  .refine(isExactHostname, 'Exact lowercase hostname required')
export const networkPolicySchema = z.strictObject({
  mode: z.enum(['offline', 'allowlist', 'blocklist']),
  domains: z.array(hostnameSchema).max(64),
  revision,
})
export type NetworkPolicy = z.infer<typeof networkPolicySchema>
/** Domain authorization only. The Host must still pin and validate resolved IPs. */
export function permitsDomain(policy: NetworkPolicy, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/[.]$/, '')
  if (!isExactHostname(host)) return false
  if (policy.mode === 'offline') return false
  if (policy.mode === 'allowlist') return policy.domains.includes(host)
  if (policy.mode === 'blocklist') return !policy.domains.some(domain => host === domain || host.endsWith('.' + domain))
  return false
}
export const NETWORK_PORTS = [80, 443] as const
export const EGRESS_LIMITS = {
  streamsPerVm: 16,
  dataFrameBytes: 48 * 1024,
  pendingBytesPerVm: 4 * 1024 * 1024,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 120_000,
} as const

/** Official destinations required by the homologated Codex device-login and API flow. */
export const CODEX_PROVIDER_PRESET = Object.freeze([
  'auth.openai.com',
  'api.openai.com',
  'chatgpt.com',
])

export const permissionSummary = {
  ask: [
    'Trabalha em arquivos do espaço de trabalho do bot sem perguntar a cada leitura.',
    'Pede autorização para ações elevadas, novos destinos de rede e exclusões protegidas.',
    'Executa tudo dentro do computador virtual do bot, nunca no seu Mac.',
  ],
  'full-vm': [
    'Controle administrativo completo dentro do computador virtual do bot.',
    'Não concede acesso ao Host nem altera a política de rede.',
    'O bot passa a pertencer ao mesmo domínio de confiança da conta conectada.',
  ],
} as const
