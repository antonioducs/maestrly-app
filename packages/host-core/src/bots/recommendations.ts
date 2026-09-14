import type { Host, Vm } from '@maestrly/host-protocol'
import type { Asset } from '../assets/catalog.js'
import { HostError } from '../errors.js'

export interface ResourceSpec {
  cpus: number
  memoryMiB: number
  diskGiB: number
}
/**
 * A bot-ready template pairs a phase-one image with the Linux runtime bundle and the
 * measured requirements recorded in its manifest. Requirements are administrator input
 * from a tested manifest; the service never invents universal minima.
 */
export interface BotTemplate {
  id: string
  imageId: string
  runtimeId: string
  arch: 'arm64' | 'x64'
  /** Linux Arm64 addon bundle (tar) for preparing a compatible existing guest. */
  runtimeBundle?: Asset & { version: string }
  /** True when the image already contains the runtime (bot-ready image). */
  runtimeIncluded: boolean
  minimum: ResourceSpec
  recommended: ResourceSpec
  capabilities: string[]
}
export interface Recommendation {
  template: BotTemplate
  resources: ResourceSpec
  source: 'recommended' | 'custom'
  blockers: { code: 'CAPACITY_APPROVAL_REQUIRED' | 'NO_BOT_TEMPLATE' | 'RUNTIME_UNAVAILABLE' | 'HOST_UNSUPPORTED'; message: string; alternatives: string[] }[]
}
const dimensions = ['cpus', 'memoryMiB', 'diskGiB'] as const
export function remaining(host: Pick<Host, 'capacity' | 'allocated'>): ResourceSpec {
  return {
    cpus: Math.max(0, host.capacity.cpus - host.allocated.cpus),
    memoryMiB: Math.max(0, host.capacity.memoryMiB - host.allocated.memoryMiB),
    diskGiB: Math.max(0, host.capacity.diskGiB - host.allocated.diskGiB),
  }
}
function fits(spec: ResourceSpec, budget: ResourceSpec) {
  return dimensions.every((d) => spec[d] <= budget[d])
}
export function pickTemplate(
  templates: readonly BotTemplate[],
  host: Pick<Host, 'arch' | 'runtimes' | 'supported'>,
  images: readonly { id: string; available: boolean }[]
): BotTemplate | undefined {
  return templates.find(
    (template) =>
      template.arch === host.arch &&
      host.runtimes.some((runtime) => runtime.id === template.runtimeId && runtime.available) &&
      images.some((image) => image.id === template.imageId && image.available)
  )
}
/** New VM: recommended resources clamped to remaining quota but never below the template minimum. */
export function recommendNewVm(
  template: BotTemplate,
  host: Pick<Host, 'capacity' | 'allocated'>,
  custom?: ResourceSpec
): Recommendation {
  const budget = remaining(host)
  const blockers: Recommendation['blockers'] = []
  let resources: ResourceSpec
  let source: Recommendation['source'] = 'recommended'
  if (custom) {
    source = 'custom'
    if (!fits(template.minimum, custom))
      throw new HostError('INVALID_REQUEST', 'Custom resources are below the template minimum')
    resources = { ...custom }
  } else
    resources = {
      cpus: Math.max(template.minimum.cpus, Math.min(template.recommended.cpus, budget.cpus)),
      memoryMiB: Math.max(template.minimum.memoryMiB, Math.min(template.recommended.memoryMiB, budget.memoryMiB)),
      diskGiB: Math.max(template.minimum.diskGiB, Math.min(template.recommended.diskGiB, budget.diskGiB)),
    }
  if (!fits(resources, budget))
    blockers.push({
      code: 'CAPACITY_APPROVAL_REQUIRED',
      message: `Não há capacidade autorizada suficiente neste computador para um novo bot (necessário ${resources.cpus} CPU, ${resources.memoryMiB} MiB, ${resources.diskGiB} GiB; disponível ${budget.cpus} CPU, ${budget.memoryMiB} MiB, ${budget.diskGiB} GiB).`,
      alternatives: [
        'Reutilizar um computador virtual existente que você escolher explicitamente.',
        'Arquivar um bot e liberar o computador dele.',
        'Pedir ao administrador para aumentar a cota do Host.',
      ],
    })
  return { template, resources, source, blockers }
}
/** Existing VM: its declared resources must satisfy the template minimum and it must be unbound. */
export function assessExistingVm(template: BotTemplate, vm: Vm, bound: boolean): Recommendation['blockers'] {
  const blockers: Recommendation['blockers'] = []
  if (bound) blockers.push({ code: 'RUNTIME_UNAVAILABLE', message: 'Este computador já pertence a outro bot.', alternatives: [] })
  if (vm.state === 'removed' || vm.state === 'unknown')
    blockers.push({ code: 'RUNTIME_UNAVAILABLE', message: 'Este computador não está em um estado seguro para preparação.', alternatives: [] })
  if (!fits(template.minimum, { cpus: vm.cpus, memoryMiB: vm.memoryMiB, diskGiB: vm.diskGiB }))
    blockers.push({
      code: 'CAPACITY_APPROVAL_REQUIRED',
      message: `O computador escolhido tem menos recursos que o mínimo do bot (${template.minimum.cpus} CPU, ${template.minimum.memoryMiB} MiB, ${template.minimum.diskGiB} GiB).`,
      alternatives: ['Escolher outro computador.', 'Criar um novo computador se houver capacidade.'],
    })
  return blockers
}
