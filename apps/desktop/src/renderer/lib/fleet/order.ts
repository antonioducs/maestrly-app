import { FLEET_ORDER_FEATURE } from '@maestrly/bot-fleet-protocol'
import type { FleetEnvironmentGroup } from './selectors'

/** Whether the owner can order bots and environments on this server (`fleet-order`). */
export const canReorder = (features: readonly string[]): boolean => features.includes(FLEET_ORDER_FEATURE)

/** `ids` with `id` taken out and put back just before or after `target`; unchanged when either is missing. */
export function placeId(ids: readonly string[], id: string, target: string, after: boolean): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return [...ids]
  const rest = ids.filter((item) => item !== id)
  const index = rest.indexOf(target) + (after ? 1 : 0)
  return [...rest.slice(0, index), id, ...rest.slice(index)]
}

/** `ids` with `id` one place earlier (-1) or later (1); unchanged at either end. */
export function shiftId(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const index = ids.indexOf(id)
  const target = ids[index + step]
  return index < 0 || target === undefined ? [...ids] : placeId(ids, id, target, step === 1)
}

/**
 * Every bot as the sidebar lists them, with one environment's bots (or the ungrouped ones, for `null`) in a new order:
 * the order a reorder sends, so that bots of other environments keep their places.
 */
export function botOrderWith(
  groups: readonly FleetEnvironmentGroup[],
  ungrouped: readonly { id: string }[],
  environmentId: string | null,
  ids: readonly string[]
): string[] {
  return [
    ...groups.flatMap((group) => (group.environment.id === environmentId ? ids : group.bots.map((bot) => bot.id))),
    ...(environmentId === null ? ids : ungrouped.map((bot) => bot.id)),
  ]
}

export const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])
