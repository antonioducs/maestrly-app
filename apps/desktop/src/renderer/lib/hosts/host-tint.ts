import type { HostView } from '../../../shared/hosts'
import { instanceColor } from '../../../shared/instance-color'

/** This computer keeps the app's warm neutral; each server gets a tint of its own, stable across windows. */
export const LOCAL_TINT: [number, number, number] = [230, 223, 208]

/** The color of a machine: the one chosen for its environment, else one derived from its id, stable across windows. */
export function hostTint(host: Pick<HostView, 'id' | 'remote' | 'tint'>): [number, number, number] {
  if (!host.remote) return LOCAL_TINT
  const chosen = host.tint && /^#[0-9a-f]{6}$/i.test(host.tint) ? host.tint : null
  if (!chosen) return instanceColor(host.id).rgb
  return [1, 3, 5].map((at) => Number.parseInt(chosen.slice(at, at + 2), 16)) as [number, number, number]
}
