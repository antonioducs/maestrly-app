import { getAppFlag } from '../store'

/**
 * Global app_settings flag for generated interfaces: the ```inline-html instructions in the system prompt and the
 * preview_interface tool. Default on. In a bot environment it is the environment's preference, set by its owner.
 * Turning it off saves their tokens; answers that already hold interfaces still render them.
 */
export const GENERATED_INTERFACES_FLAG = 'chat.generatedInterfaces'

export function generatedInterfacesEnabled(): boolean {
  return getAppFlag(GENERATED_INTERFACES_FLAG, true)
}
