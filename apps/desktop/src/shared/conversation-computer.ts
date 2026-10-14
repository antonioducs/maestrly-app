/**
 * What opening a workspaces conversation's computer gives (`drawer:computer-open`): the computer's display, whether
 * this call started it, or why there is none: every slot of the server is taken (by the conversations named), or the
 * server has no computers.
 */
export type ComputerOpenResult =
  | { ok: true; display: string; started: boolean }
  | { ok: false; reason: 'busy'; holders: string[] }
  | { ok: false; reason: 'unavailable' }
